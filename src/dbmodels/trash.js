const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Mette in coda lo spostamento nel cestino. Non tocca il file: a muoverlo e'
// il pod scan, l'unico con la share montata in scrittura. L'API resta in sola
// lettura, ed e' una garanzia strutturale che nessun bug qui dentro possa
// danneggiare la libreria.
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

// Coda del job trashapply: file da spostare.
async function getPendingTrash(limit) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.trash_id, t.media_id, t.original_path, t.trash_path, r.rel_path
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
             WHERE trash_id = $1 RETURNING media_id, other_id`,
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
            SELECT t.trash_id, t.trash_path, t.file_size, r.rel_path
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
    requestTrash, requestTrashOther, getPendingTrash, completeTrash,
    getExpiredTrash, completePurge, getTrash, getTrashStats,
};
