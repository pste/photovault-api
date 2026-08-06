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

module.exports = { upsertBatch, markMissing, getOthers, countOthers, getStats };
