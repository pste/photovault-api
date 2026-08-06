const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');
const utils = require('../utils');
const { NOT_TRASHED_MEDIA } = require('./sqlparts');

async function getFolder(folder_id) {
    const client = await pool.connect();
    try {
        const stm = 'SELECT * FROM folders WHERE folder_id = $1';
        logger.trace({ folder_id }, 'DB: getFolder');
        const res = await client.query(stm, [folder_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getFolder', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Figli diretti di una cartella. parent_id NULL = primo livello della root.
// IS NOT DISTINCT FROM tratta correttamente il NULL, cosi' serve una query sola.
async function getSubfolders(root_id, parent_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT folder_id, root_id, parent_id, "name", "path", depth
            FROM folders
            WHERE root_id = $1
              AND parent_id IS NOT DISTINCT FROM $2
              AND missing_since IS NULL
            ORDER BY "name"`;
        logger.trace({ root_id, parent_id }, 'DB: getSubfolders');
        const res = await client.query(stm, [root_id, parent_id]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getSubfolders', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Conteggi di una lista di cartelle, calcolati al momento.
//
// Erano due colonne denormalizzate su folders, aggiornate a fine scansione: il
// numero restava quindi falso per tutta la durata dello scan, e per sempre se
// lo scan falliva prima del reconcile -- una cartella con 11.807 foto dentro
// mostrava "vuota". Misurato sull'archivio vero (132k media, 1.730 cartelle):
// 2,9 ms sulla cartella con piu' sottocartelle che esista in archivio, cioe'
// meno della query delle anteprime che sta nella stessa richiesta.
//
// Le sottoquery correlate non sono piu' lente della GROUP BY equivalente --
// misurate entrambe -- e dicono a colpo d'occhio cosa contano.
async function getFolderCounts(folder_ids) {
    if (!folder_ids || folder_ids.length === 0) {
        return [];
    }
    const client = await pool.connect();
    try {
        const stm = `
            SELECT f.folder_id,
                   (SELECT count(*) FROM media m
                     WHERE m.folder_id = f.folder_id AND m.missing_since IS NULL
                       AND ${NOT_TRASHED_MEDIA('m')}) AS media_count,
                   (SELECT count(*) FROM folders s
                     WHERE s.parent_id = f.folder_id AND s.missing_since IS NULL) AS sub_count
            FROM folders f
            WHERE f.folder_id = ANY($1)`;
        logger.trace('DB: getFolderCounts');
        const res = await client.query(stm, [folder_ids]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getFolderCounts', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getFolderByPath(root_id, folderPath) {
    const client = await pool.connect();
    try {
        const stm = 'SELECT * FROM folders WHERE root_id = $1 AND "path" = $2';
        logger.trace({ root_id, folderPath }, 'DB: getFolderByPath');
        const res = await client.query(stm, [root_id, folderPath]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getFolderByPath', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Breadcrumb. Si calcolano i percorsi degli antenati in JS e si prendono in una
// query sola colpendo l'indice unique (root_id, path): niente CTE ricorsiva.
async function getBreadcrumb(root_id, folderPath) {
    // La stringa vuota e' la cartella radice: fa sempre parte del percorso.
    const paths = [''].concat(utils.ancestorPaths(folderPath));
    const client = await pool.connect();
    try {
        const stm = `
            SELECT folder_id, "name", "path", depth
            FROM folders
            WHERE root_id = $1 AND "path" = ANY($2)
            ORDER BY depth`;
        logger.trace({ root_id, folderPath }, 'DB: getBreadcrumb');
        const res = await client.query(stm, [root_id, paths]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getBreadcrumb', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Le prime N thumbnail di una cartella, per il mosaico del tile.
// E' quel dettaglio che fa sembrare un'app per foto invece di un file manager.
//
// Si campiona dall'INTERO sottoalbero, non dai soli figli diretti: in un
// archivio vero le foto stanno nelle foglie, quindi limitarsi ai figli diretti
// lascerebbe grigie tutte le cartelle intermedie, che sono proprio quelle che
// si vedono per prime. Il confronto per prefisso usa il path materializzato e
// il suo indice text_pattern_ops; la LATERAL applica il LIMIT per cartella,
// cosi' non si legge l'intero sottoalbero per poi buttarlo via.
async function getFolderPreviews(folder_ids, perFolder) {
    if (!folder_ids || folder_ids.length === 0) {
        return [];
    }
    const client = await pool.connect();
    try {
        const stm = `
            SELECT p.folder_id, t.media_id, t.updated
            FROM folders p
            JOIN LATERAL (
                SELECT m.media_id, m.updated
                FROM media m
                JOIN folders f ON f.folder_id = m.folder_id
                WHERE f.root_id = p.root_id
                  AND f."path" LIKE p."path" || '%'
                  AND m.missing_since IS NULL
                  AND m.thumb_status = 'done'
                  AND ${NOT_TRASHED_MEDIA('m')}
                ORDER BY m.capture_ts DESC NULLS LAST, m.media_id
                LIMIT $2
            ) t ON true
            WHERE p.folder_id = ANY($1)`;
        logger.trace('DB: getFolderPreviews');
        const res = await client.query(stm, [folder_ids, perFolder]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getFolderPreviews', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Usata dallo scan: crea la cartella se non esiste e ne restituisce l'id.
// Il path e' materializzato, quindi si ricava tutto da root_id + path.
async function upsertFolder(root_id, parent_id, name, folderPath, depth) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO folders (root_id, parent_id, "name", "path", depth)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (root_id, "path")
            DO UPDATE SET parent_id = EXCLUDED.parent_id,
                          "name" = EXCLUDED."name",
                          depth = EXCLUDED.depth,
                          missing_since = NULL
            RETURNING *`;
        const pars = [root_id, parent_id, name, folderPath, depth];
        logger.trace(pars, 'DB: upsertFolder');
        const res = await client.query(stm, pars);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertFolder', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    getFolder, getFolderByPath, getSubfolders, getBreadcrumb, getFolderPreviews,
    getFolderCounts, upsertFolder,
};
