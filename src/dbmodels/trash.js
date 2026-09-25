const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');
const { NOT_TRASHED_MEDIA, NOT_TRASHED_OTHER, NOT_TRASHED_FOLDER } = require('./sqlparts');

// Mette in coda lo spostamento nel cestino. Non tocca il file: a muoverlo e'
// il pod scan, l'unico con la share montata in scrittura. L'API resta in sola
// lettura, ed e' una garanzia strutturale che nessun bug qui dentro possa
// danneggiare la libreria.
//
// Un file gia' in coda, o dentro una cartella gia' in coda, non si accoda di
// nuovo e la funzione restituisce null. Senza, un doppio clic o due gruppi di
// duplicati sovrapposti creavano due spostamenti dello stesso file: il secondo
// non trovava piu' la sorgente e finiva in errore.
async function requestTrash(media_id) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO trash (media_id, root_id, original_path, trash_path,
                               file_size, content_hash)
            SELECT m.media_id,
                   f.root_id,
                   f."path" || m.file_name,
                   '.photovault/trash/' || to_char(NOW(), 'YYYYMMDD') || '/'
                       || m.media_id || '_' || m.file_name,
                   m.file_size,
                   m.content_hash
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            WHERE m.media_id = $1
              AND ${NOT_TRASHED_MEDIA('m')}
              AND ${NOT_TRASHED_FOLDER('f')}
            RETURNING *`;
        logger.trace({ media_id }, 'DB: requestTrash');
        const res = await client.query(stm, [media_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB requestTrash', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Come requestTrash, ma per un file non gestito da photovault. La riga di
// cestino ha la stessa forma -- e' fatta di percorsi -- quindi il pod scan
// sposta questi file con lo stesso codice, senza sapere da dove vengano.
async function requestTrashOther(other_id) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO trash (other_id, root_id, original_path, trash_path, file_size)
            SELECT o.other_id,
                   o.root_id,
                   o."path" || o.file_name,
                   '.photovault/trash/' || to_char(NOW(), 'YYYYMMDD') || '/'
                       || o.other_id || '_' || o.file_name,
                   o.file_size
            FROM other_files o
            WHERE o.other_id = $1
              AND ${NOT_TRASHED_OTHER('o')}
              AND ${NOT_TRASHED_FOLDER('o')}
            RETURNING *`;
        logger.trace({ other_id }, 'DB: requestTrashOther');
        const res = await client.query(stm, [other_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB requestTrashOther', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Cestina una cartella intera: una sola riga di trash, che rappresenta una
// rename dell'intera cartella. Il conteggio e la dimensione sono quelli
// dell'INTERO sottoalbero, perche' e' quello che si muove.
//
// Le richieste gia' in coda per file e cartelle del sottoalbero si tolgono:
// la rename della cartella le porta nel cestino comunque, e se trashapply le
// eseguisse dopo non troverebbe piu' la sorgente.
async function requestTrashFolder(folder_id) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stm = `
            INSERT INTO trash (folder_id, root_id, original_path, trash_path,
                               file_size, file_count)
            SELECT f.folder_id,
                   f.root_id,
                   f."path",
                   '.photovault/trash/' || to_char(NOW(), 'YYYYMMDD') || '/'
                       || f.folder_id || '_' || f."name",
                   COALESCE(sub.bytes, 0),
                   COALESCE(sub.files, 0)
            FROM folders f
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS files, COALESCE(sum(m.file_size), 0)::bigint AS bytes
                FROM media m
                JOIN folders d ON d.folder_id = m.folder_id
                WHERE d.root_id = f.root_id AND starts_with(d."path", f."path")
            ) sub ON true
            WHERE f.folder_id = $1
              AND f."path" <> ''
              AND ${NOT_TRASHED_FOLDER('f')}
            RETURNING *`;
        logger.trace({ folder_id }, 'DB: requestTrashFolder');
        const res = await client.query(stm, [folder_id]);
        const row = res.rows[0] || null;
        if (row) {
            await client.query(`
                DELETE FROM trash t
                USING folders f
                WHERE f.folder_id = $1
                  AND t."status" = 'pending'
                  AND t.trash_id <> $2
                  AND t.root_id = f.root_id
                  AND starts_with(t.original_path, f."path")`,
                [folder_id, row.trash_id]);
        }
        await client.query('COMMIT');
        return row;
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB requestTrashFolder', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// I media contenuti in una cartella e in tutte le sue discendenti. Serve al pod
// scan per togliere le thumbnail: la rename porta via gli originali, ma le
// anteprime vivono in .photovault/thumbs/ e resterebbero orfane.
async function getFolderMediaIds(folder_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT m.media_id
            FROM folders f
            JOIN folders d ON d.root_id = f.root_id AND starts_with(d."path", f."path")
            JOIN media m ON m.folder_id = d.folder_id
            WHERE f.folder_id = $1`;
        const res = await client.query(stm, [folder_id]);
        return res.rows.map((r) => r.media_id);
    }
    catch(err) {
        dblog.createLog('ERROR DB getFolderMediaIds', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Coda del job trashapply: file da spostare.
async function getPendingTrash(limit) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.trash_id, t.media_id, t.folder_id, t.original_path, t.trash_path, r.rel_path
            FROM trash t
            JOIN roots r ON r.root_id = t.root_id
            WHERE t."status" = 'pending'
            ORDER BY t.trash_id
            LIMIT $1`;
        logger.trace({ limit }, 'DB: getPendingTrash');
        const res = await client.query(stm, [limit]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getPendingTrash', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Spostamento eseguito: la riga media sparisce dalla libreria (la cascade
// porta via tag, embedding e appartenenze ai gruppi), mentre la riga di trash
// resta come registro di cosa e' stato cestinato e quando.
async function completeTrash(trash_id, status, result) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await client.query(
            `UPDATE trash SET "status" = $2, executed = NOW(), "result" = $3
             WHERE trash_id = $1 RETURNING media_id, other_id, folder_id`,
            [trash_id, status, result || null]);

        // Una riga di cestino viene da media oppure da other_files, mai da
        // entrambe: a spostamento avvenuto sparisce quella di origine.
        if (status === 'done' && res.rows[0]) {
            if (res.rows[0].media_id) {
                await client.query('DELETE FROM media WHERE media_id = $1', [res.rows[0].media_id]);
            }
            if (res.rows[0].other_id) {
                await client.query('DELETE FROM other_files WHERE other_id = $1', [res.rows[0].other_id]);
            }
            // Una cartella spostata porta via il suo intero sottoalbero: prima i
            // media (la cascade si occupa di tag, embedding e appartenenze),
            // poi i file non gestiti, infine le cartelle stesse. L'ordine e'
            // obbligato dalla foreign key media -> folders.
            if (res.rows[0].folder_id) {
                const sub = `
                    SELECT d.folder_id, d.root_id, d."path"
                    FROM folders f
                    JOIN folders d ON d.root_id = f.root_id AND starts_with(d."path", f."path")
                    WHERE f.folder_id = $1`;
                await client.query(`DELETE FROM media WHERE folder_id IN (SELECT folder_id FROM (${sub}) s)`,
                                   [res.rows[0].folder_id]);
                await client.query(`DELETE FROM other_files o
                                    WHERE EXISTS (SELECT 1 FROM (${sub}) s
                                                  WHERE s.root_id = o.root_id AND s."path" = o."path")`,
                                   [res.rows[0].folder_id]);
                await client.query(`DELETE FROM folders WHERE folder_id IN (SELECT folder_id FROM (${sub}) s)`,
                                   [res.rows[0].folder_id]);
            }
        }
        await client.query('COMMIT');
        logger.trace({ trash_id, status }, 'DB: completeTrash');
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB completeTrash', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Coda del job trashpurge: file nel cestino da piu' giorni della ritenzione.
// E' la finestra entro cui un ripensamento e' ancora recuperabile con un mv.
async function getExpiredTrash(retentionDays, limit) {
    const client = await pool.connect();
    try {
        const stm = `
            -- media_id serve al pod per togliere la thumbnail, che resta sulla
            -- share per tutta la ritenzione: e' quella che la pagina Cestino
            -- mostra accanto alla riga. La colonna sopravvive alla cancellazione
            -- della riga media, perche' non ha una foreign key.
            SELECT t.trash_id, t.trash_path, t.file_size, t.media_id, r.rel_path
            FROM trash t
            JOIN roots r ON r.root_id = t.root_id
            WHERE t."status" = 'done'
              AND t.executed < NOW() - ($1 || ' days')::interval
            ORDER BY t.executed
            LIMIT $2`;
        logger.trace({ retentionDays, limit }, 'DB: getExpiredTrash');
        const res = await client.query(stm, [String(retentionDays), limit]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getExpiredTrash', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function completePurge(trash_id, status, result) {
    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE trash SET "status" = $2, "result" = $3 WHERE trash_id = $1',
            [trash_id, status, result || null]);
        logger.trace({ trash_id, status }, 'DB: completePurge');
    }
    catch(err) {
        dblog.createLog('ERROR DB completePurge', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Contenuto del cestino per la UI, con i giorni che mancano allo svuotamento.
async function getTrash(status, limit, offset) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.*,
                   GREATEST(0, p.trash_retention_days
                       - EXTRACT(DAY FROM NOW() - t.executed))::int AS giorni_rimasti
            FROM trash t
            CROSS JOIN (SELECT trash_retention_days FROM parameters LIMIT 1) p
            WHERE ($1::varchar IS NULL OR t."status" = $1)
            ORDER BY t.trash_id DESC
            LIMIT $2 OFFSET $3`;
        logger.trace({ status }, 'DB: getTrash');
        const res = await client.query(stm, [status || null, limit, offset]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getTrash', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getTrashStats() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT
                count(*) FILTER (WHERE "status" = 'pending')::int AS in_attesa,
                count(*) FILTER (WHERE "status" = 'done')::int AS nel_cestino,
                count(*) FILTER (WHERE "status" = 'purged')::int AS eliminati,
                COALESCE(sum(file_size) FILTER (WHERE "status" = 'done'), 0)::bigint AS bytes_nel_cestino
            FROM trash`;
        const res = await client.query(stm);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB getTrashStats', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    requestTrash, requestTrashOther, requestTrashFolder, getFolderMediaIds,
    getPendingTrash, completeTrash,
    getExpiredTrash, completePurge, getTrash, getTrashStats,
};
