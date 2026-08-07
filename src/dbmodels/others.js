const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');
const { NOT_TRASHED_OTHER } = require('./sqlparts');

const SCAN_COLUMNS = ['root_id', '"path"', 'file_name', 'ext', 'file_size', 'modified'];

// Upsert di un blocco di file non gestiti. Stessa forma di upsertMediaBatch: lo
// scan manda tutto quello che incontra e l'ON CONFLICT distingue il nuovo dal
// gia' visto, cosi' il pod non deve interrogare il database.
async function upsertBatch(items) {
    if (!items || items.length === 0) {
        return 0;
    }
    const client = await pool.connect();
    try {
        const values = [];
        const pars = [];
        items.forEach((item, row) => {
            const base = row * SCAN_COLUMNS.length;
            values.push(`(${SCAN_COLUMNS.map((_, i) => `$${base + i + 1}`).join(', ')})`);
            pars.push(item.root_id, item.path, item.file_name, item.ext,
                      item.file_size, item.modified);
        });

        const stm = `
            INSERT INTO other_files (${SCAN_COLUMNS.join(', ')})
            VALUES ${values.join(', ')}
            ON CONFLICT (root_id, "path", file_name) DO UPDATE SET
                last_seen     = NOW(),
                missing_since = NULL,
                file_size     = EXCLUDED.file_size,
                modified      = EXCLUDED.modified`;
        logger.trace({ rows: items.length }, 'DB: others.upsertBatch');
        await client.query(stm, pars);
        return items.length;
    }
    catch(err) {
        dblog.createLog('ERROR DB others.upsertBatch', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Chi non e' stato visto in questa scansione e' sparito dal disco. Nessun guard
// come quello dei media: qui non si cancella niente, si marca soltanto, e la
// riga torna visibile da sola al primo scan che ritrova il file.
async function markMissing(root_id, scanStartedAt) {
    const client = await pool.connect();
    try {
        const stm = `
            UPDATE other_files
            SET missing_since = NOW()
            WHERE root_id = $1 AND last_seen < $2 AND missing_since IS NULL`;
        logger.trace({ root_id }, 'DB: others.markMissing');
        const res = await client.query(stm, [root_id, scanStartedAt]);
        return res.rowCount;
    }
    catch(err) {
        dblog.createLog('ERROR DB others.markMissing', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Elenco per la pagina "Altri file". L'ordinamento predefinito e' per
// dimensione: quello che interessa togliere sono i file grossi.
async function getOthers({ ext, sort, limit, offset }) {
    const client = await pool.connect();
    try {
        const order = (sort === 'path')
            ? '"path", file_name'
            : 'file_size DESC, other_id';
        const filter = ext ? 'AND ext = $3' : '';
        const pars = ext ? [limit, offset, ext.toLowerCase()] : [limit, offset];

        const stm = `
            SELECT o.other_id, o."path", o.file_name, o.ext, o.file_size, o.modified,
                   r."name" AS root_name
            FROM other_files o
            JOIN roots r ON r.root_id = o.root_id
            WHERE o.missing_since IS NULL AND ${NOT_TRASHED_OTHER('o')} ${filter}
            ORDER BY ${order}
            LIMIT $1 OFFSET $2`;
        logger.trace({ ext, sort, limit, offset }, 'DB: getOthers');
        const res = await client.query(stm, pars);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getOthers', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Totali e ripartizione per estensione: e' la vista che dice davvero cosa c'e'
// sulla share oltre alla libreria, e da dove conviene cominciare a fare pulizia.
async function getStats() {
    const client = await pool.connect();
    try {
        const totals = await client.query(`
            SELECT count(*)::int AS files, COALESCE(sum(file_size), 0)::bigint AS bytes
            FROM other_files o WHERE o.missing_since IS NULL AND ${NOT_TRASHED_OTHER('o')}`);
        const byExt = await client.query(`
            SELECT o.ext, count(*)::int AS files, sum(o.file_size)::bigint AS bytes
            FROM other_files o WHERE o.missing_since IS NULL AND ${NOT_TRASHED_OTHER('o')}
            GROUP BY o.ext ORDER BY bytes DESC LIMIT 20`);
        logger.trace('DB: getOthersStats');
        return { ...totals.rows[0], by_ext: byExt.rows };
    }
    catch(err) {
        dblog.createLog('ERROR DB getOthersStats', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function countOthers(ext) {
    const client = await pool.connect();
    try {
        const filter = ext ? 'AND ext = $1' : '';
        const pars = ext ? [ext.toLowerCase()] : [];
        const res = await client.query(`
            SELECT count(*)::int AS n FROM other_files o
            WHERE o.missing_since IS NULL AND ${NOT_TRASHED_OTHER('o')} ${filter}`, pars);
        return res.rows[0].n;
    }
    catch(err) {
        dblog.createLog('ERROR DB countOthers', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Un singolo file non gestito, con la radice che serve a costruirne il percorso.
async function getDetail(other_id) {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT o.other_id, o."path", o.file_name, o.ext, o.file_size, r.rel_path
            FROM other_files o
            JOIN roots r ON r.root_id = o.root_id
            WHERE o.other_id = $1`, [other_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB others.getDetail', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Sposta dei media fra i file non gestiti: la riga esce da media ed entra in
// other_files, conservando percorso, dimensione e data.
//
// Serve perche' l'estensione mente. WhatsApp salva le note vocali in .3gp, che
// e' un contenitore video e sta nell'allowlist perche' i telefoni vecchi ci
// giravano i filmati veri: solo aprendo il file si scopre che dentro non c'e'
// nessuna traccia video. Lasciarle in media significherebbe 98 riquadri rotti
// nella griglia e un errore di anteprima che si ripresenta a ogni giro.
//
// Le tabelle collegate spariscono da sole: media_tags, media_embeddings e
// dup_members hanno ON DELETE CASCADE.
async function markNotMedia(mediaIds) {
    if (!mediaIds || mediaIds.length === 0) {
        return { moved: 0, kept: 0 };
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Primo: tutte fuori dalla coda, comunque vada il resto. Se una riga
        // restasse 'pending' il pod la ritroverebbe al giro dopo, la
        // rispedirebbe qui e non uscirebbe mai dal ciclo.
        await client.query(
            `UPDATE media SET thumb_status = 'error', updated = NOW()
             WHERE media_id = ANY($1) AND thumb_status = 'pending'`, [mediaIds]);

        // Un media in attesa di cestinamento non si tocca: il cestino conosce
        // il suo media_id, e cancellargli la riga sotto lascerebbe il job
        // trashapply con un riferimento nel vuoto.
        const movable = `
            SELECT m.media_id, f.root_id, f."path", m.file_name, m.ext,
                   m.file_size, m.modified
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            WHERE m.media_id = ANY($1)
              AND NOT EXISTS (SELECT 1 FROM trash tr WHERE tr.media_id = m.media_id)`;

        const res = await client.query(`
            WITH movable AS (${movable}),
            inserted AS (
                INSERT INTO other_files (root_id, "path", file_name, ext, file_size, modified)
                SELECT root_id, "path", file_name, ext, file_size, modified FROM movable
                ON CONFLICT (root_id, "path", file_name) DO UPDATE SET
                    last_seen     = NOW(),
                    missing_since = NULL,
                    file_size     = EXCLUDED.file_size,
                    modified      = EXCLUDED.modified
            )
            DELETE FROM media WHERE media_id IN (SELECT media_id FROM movable)`, [mediaIds]);

        // kept si conta, non si sottrae: fra gli id richiesti ce ne possono
        // essere di gia' spostati o inesistenti, che non sono "trattenuti".
        const rest = await client.query(
            'SELECT count(*)::int AS n FROM media WHERE media_id = ANY($1)', [mediaIds]);

        await client.query('COMMIT');
        logger.info({ moved: res.rowCount, richiesti: mediaIds.length }, 'DB: markNotMedia');
        return { moved: res.rowCount, kept: rest.rows[0].n };
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB markNotMedia', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    upsertBatch, markMissing, getOthers, countOthers, getStats, markNotMedia, getDetail,
};
