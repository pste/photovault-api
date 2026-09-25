const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Salva gli hash calcolati dal pod dedup. sha256 e dHash arrivano in momenti
// diversi (il primo legge l'originale, il secondo la thumbnail), quindi ogni
// campo si aggiorna solo se valorizzato.
async function saveHashes(items) {
    if (!items || items.length === 0) {
        return 0;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stm = `
            UPDATE media SET
                content_hash = COALESCE($2, content_hash),
                hash_kind    = COALESCE($3, hash_kind),
                dhash        = COALESCE($4::bit(64), dhash)
            WHERE media_id = $1`;
        for (const item of items) {
            await client.query(stm, [
                item.media_id,
                item.content_hash || null,
                item.hash_kind || null,
                item.dhash || null,
            ]);
        }
        await client.query('COMMIT');
        logger.trace({ rows: items.length }, 'DB: saveHashes');
        return items.length;
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB saveHashes', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Duplicati esatti: nessun join, basta raggruppare per hash.
async function findExactGroups() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT content_hash,
                   array_agg(media_id ORDER BY media_id) AS members,
                   count(*)::int AS n,
                   (sum(file_size) - min(file_size))::bigint AS bytes_wasted
            FROM media
            WHERE content_hash IS NOT NULL
              AND missing_since IS NULL
            GROUP BY content_hash
            HAVING count(*) > 1`;
        logger.trace('DB: findExactGroups');
        const res = await client.query(stm);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB findExactGroups', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Membri dei gruppi esatti gia' in archivio, come "id,id,id" per chiave: serve
// al rebuild per riscrivere solo i gruppi cambiati.
async function getExactGroupMembers() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT g.group_key, string_agg(d.media_id::text, ',' ORDER BY d.media_id) AS members
            FROM dup_groups g
            JOIN dup_members d ON d.dup_group_id = g.dup_group_id
            WHERE g.kind = 'exact'
            GROUP BY g.group_key`;
        const res = await client.query(stm);
        return new Map(res.rows.map((row) => [row.group_key, row.members]));
    }
    catch(err) {
        dblog.createLog('ERROR DB getExactGroupMembers', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Il prossimo blocco di media da confrontare, e quanti ne restano in tutto.
async function nextToCompare(limit) {
    const client = await pool.connect();
    try {
        const ids = await client.query(`
            SELECT media_id FROM media
            WHERE dedup_checked IS NULL AND dhash IS NOT NULL
            ORDER BY media_id
            LIMIT $1`, [limit]);
        const left = await client.query(`
            SELECT count(*)::int AS n FROM media
            WHERE dedup_checked IS NULL AND dhash IS NOT NULL`);
        return { ids: ids.rows.map((row) => row.media_id), left: left.rows[0].n };
    }
    catch(err) {
        dblog.createLog('ERROR DB nextToCompare', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Coppie percettivamente simili.
//
// Il confronto e' INCREMENTALE: solo le righe mai confrontate (dedup_checked
// NULL) vengono messe contro l'intero corpus, e un blocco alla volta: gli id
// arrivano da nextToCompare. Il primo giro e' quello caro, i
// successivi sono "poche righe nuove per tutte le vecchie", cioe' quasi nulla.
// Batte l'LSH banding su semplicita' e su correttezza: il banding con 4 bande
// da 16 bit garantisce il recall completo solo fino a distanza 3.
//
// bit_count() e' core PostgreSQL 14 e su bit(64) il # e' lo XOR: nessuna
// estensione da installare.
//
// Il filtro bit_count(dhash) BETWEEN 8 AND 56 scarta le immagini piatte, nere o
// bianche: il loro dHash e' degenere e somiglierebbe a tutto, creando un unico
// enorme gruppo di falsi positivi.
async function findSimilarPairs(maxDistance, ids) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT a.media_id AS a_id, b.media_id AS b_id,
                   bit_count(a.dhash # b.dhash)::int AS distance
            FROM media a
            JOIN media b ON b.media_id <> a.media_id
            WHERE a.media_id = ANY($2)
              AND a.dhash IS NOT NULL AND b.dhash IS NOT NULL
              AND a.missing_since IS NULL AND b.missing_since IS NULL
              AND bit_count(a.dhash) BETWEEN 8 AND 56
              AND bit_count(b.dhash) BETWEEN 8 AND 56
              AND a.content_hash IS DISTINCT FROM b.content_hash
              AND bit_count(a.dhash # b.dhash) <= $1
            ORDER BY a.media_id, distance`;
        logger.trace({ maxDistance }, 'DB: findSimilarPairs');
        const res = await client.query(stm, [maxDistance, ids]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB findSimilarPairs', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Si segnano solo gli id del blocco appena confrontato: un dHash arrivato nel
// frattempo resta in coda invece di risultare confrontato senza esserlo.
async function markDedupChecked(ids) {
    const client = await pool.connect();
    try {
        const stm = 'UPDATE media SET dedup_checked = NOW() WHERE media_id = ANY($1)';
        const res = await client.query(stm, [ids]);
        logger.trace({ rows: res.rowCount }, 'DB: markDedupChecked');
        return res.rowCount;
    }
    catch(err) {
        dblog.createLog('ERROR DB markDedupChecked', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Materializza un gruppo. ON CONFLICT DO NOTHING sulla chiave (kind, group_key)
// e' quello che PRESERVA LE DECISIONI DELL'UTENTE: un gruppo gia' risolto o
// ignorato non viene ricreato al rebuild successivo.
async function upsertGroup(kind, groupKey, members, keeperId, bytesWasted, distances) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const groupRes = await client.query(`
            INSERT INTO dup_groups (kind, group_key, member_count, bytes_wasted)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (kind, group_key) DO NOTHING
            RETURNING dup_group_id, "status"`,
            [kind, String(groupKey), members.length, bytesWasted]);

        let group = groupRes.rows[0];
        if (!group) {
            const existing = await client.query(
                'SELECT dup_group_id, "status" FROM dup_groups WHERE kind = $1 AND group_key = $2',
                [kind, String(groupKey)]);
            group = existing.rows[0];

            // Gruppo gia' deciso dall'utente: non si tocca.
            if (group.status !== 'open') {
                await client.query('COMMIT');
                return { dup_group_id: group.dup_group_id, skipped: true };
            }
            await client.query(
                'UPDATE dup_groups SET member_count = $2, bytes_wasted = $3 WHERE dup_group_id = $1',
                [group.dup_group_id, members.length, bytesWasted]);
            await client.query('DELETE FROM dup_members WHERE dup_group_id = $1', [group.dup_group_id]);
        }

        for (const media_id of members) {
            await client.query(`
                INSERT INTO dup_members (dup_group_id, media_id, distance, is_keeper)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (dup_group_id, media_id) DO UPDATE
                    SET distance = EXCLUDED.distance, is_keeper = EXCLUDED.is_keeper`,
                [group.dup_group_id, media_id, distances[media_id] || 0, media_id === keeperId]);
        }

        await client.query('COMMIT');
        return { dup_group_id: group.dup_group_id, skipped: false };
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB upsertGroup', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Gruppi simili ancora aperti che contengono almeno uno dei media dati, con
// l'elenco completo dei loro membri. Servono al rebuild incrementale per
// fondere i gruppi esistenti con le coppie nuove.
async function getOpenSimilarGroupsOf(ids) {
    if (!ids || ids.length === 0) {
        return [];
    }
    const client = await pool.connect();
    try {
        const stm = `
            SELECT g.dup_group_id, g.group_key,
                   array_agg(d.media_id ORDER BY d.media_id) AS members
            FROM dup_groups g
            JOIN dup_members d ON d.dup_group_id = g.dup_group_id
            WHERE g.kind = 'similar' AND g."status" = 'open'
              AND g.dup_group_id IN (SELECT dup_group_id FROM dup_members WHERE media_id = ANY($1))
            GROUP BY g.dup_group_id, g.group_key`;
        logger.trace({ ids: ids.length }, 'DB: getOpenSimilarGroupsOf');
        const res = await client.query(stm, [ids]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getOpenSimilarGroupsOf', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Elimina gruppi aperti assorbiti da un gruppo piu' grande. La cascade toglie
// i membri; un gruppo gia' deciso dall'utente non si tocca mai.
async function deleteOpenGroups(ids) {
    if (!ids || ids.length === 0) {
        return 0;
    }
    const client = await pool.connect();
    try {
        const res = await client.query(
            `DELETE FROM dup_groups WHERE dup_group_id = ANY($1) AND "status" = 'open'`, [ids]);
        logger.trace({ rows: res.rowCount }, 'DB: deleteOpenGroups');
        return res.rowCount;
    }
    catch(err) {
        dblog.createLog('ERROR DB deleteOpenGroups', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Gruppi ancora aperti che non hanno piu' almeno due membri: succede dopo che
// l'utente ha svuotato un gruppo, o quando i file spariscono dal disco.
async function dropStaleGroups() {
    const client = await pool.connect();
    try {
        const stm = `
            DELETE FROM dup_groups g
            WHERE g."status" = 'open'
              AND (SELECT count(*) FROM dup_members m WHERE m.dup_group_id = g.dup_group_id) < 2`;
        const res = await client.query(stm);
        logger.trace({ rows: res.rowCount }, 'DB: dropStaleGroups');
        return res.rowCount;
    }
    catch(err) {
        dblog.createLog('ERROR DB dropStaleGroups', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Dati minimi per scegliere il keeper di un gruppo.
async function getMediaBrief(ids) {
    if (!ids || ids.length === 0) {
        return [];
    }
    const client = await pool.connect();
    try {
        const stm = `
            SELECT m.media_id, m.file_size, m.width, m.height, m.modified,
                   m.dhash::text AS dhash,
                   f."path" || m.file_name AS full_path
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            WHERE m.media_id = ANY($1)`;
        const res = await client.query(stm, [ids]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getMediaBrief', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getGroups(status, kind, limit, offset) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT g.*,
                   (SELECT count(*)::int FROM dup_members m WHERE m.dup_group_id = g.dup_group_id) AS members
            FROM dup_groups g
            WHERE ($1::varchar IS NULL OR g."status" = $1)
              AND ($2::varchar IS NULL OR g.kind = $2)
            ORDER BY g.bytes_wasted DESC, g.dup_group_id
            LIMIT $3 OFFSET $4`;
        logger.trace({ status, kind }, 'DB: getGroups');
        const res = await client.query(stm, [status || null, kind || null, limit, offset]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getGroups', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function countGroups(status, kind) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT count(*)::int AS n FROM dup_groups g
            WHERE ($1::varchar IS NULL OR g."status" = $1)
              AND ($2::varchar IS NULL OR g.kind = $2)`;
        const res = await client.query(stm, [status || null, kind || null]);
        return res.rows[0].n;
    }
    catch(err) {
        dblog.createLog('ERROR DB countGroups', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Membri di un gruppo con tutto quello che serve alla UI per decidere:
// anteprima, dimensioni, percorso e data.
async function getGroupMembers(dup_group_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT m.media_id, m.file_name, m.media_kind, m.file_size,
                   m.width, m.height, m.capture_ts, m.thumb_status, m.hash_kind,
                   EXTRACT(EPOCH FROM m.updated)::bigint AS v,
                   f."path" AS folder_path, f.folder_id,
                   d.distance, d.is_keeper
            FROM dup_members d
            JOIN media m ON m.media_id = d.media_id
            JOIN folders f ON f.folder_id = m.folder_id
            WHERE d.dup_group_id = $1
            ORDER BY d.is_keeper DESC, m.width DESC NULLS LAST, m.file_size DESC`;
        logger.trace({ dup_group_id }, 'DB: getGroupMembers');
        const res = await client.query(stm, [dup_group_id]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getGroupMembers', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getGroup(dup_group_id) {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT * FROM dup_groups WHERE dup_group_id = $1', [dup_group_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getGroup', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function setGroupStatus(dup_group_id, status) {
    const client = await pool.connect();
    try {
        await client.query('UPDATE dup_groups SET "status" = $2 WHERE dup_group_id = $1',
            [dup_group_id, status]);
    }
    catch(err) {
        dblog.createLog('ERROR DB setGroupStatus', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getStats() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT
                count(*) FILTER (WHERE "status" = 'open')::int AS aperti,
                count(*) FILTER (WHERE "status" = 'resolved')::int AS risolti,
                count(*) FILTER (WHERE "status" = 'ignored')::int AS ignorati,
                COALESCE(sum(bytes_wasted) FILTER (WHERE "status" = 'open'), 0)::bigint AS bytes_recuperabili
            FROM dup_groups`;
        const res = await client.query(stm);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB getStats duplicati', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    saveHashes, findExactGroups, getExactGroupMembers, nextToCompare, findSimilarPairs, markDedupChecked,
    upsertGroup, getOpenSimilarGroupsOf, deleteOpenGroups, dropStaleGroups, getMediaBrief,
    getGroups, countGroups, getGroupMembers, getGroup, setGroupStatus, getStats,
};
