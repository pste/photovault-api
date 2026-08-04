const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Tag con il conteggio d'uso, per la barra dei filtri.
async function getTags() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.tag_id, t."name", t.display_name, t.kind, count(mt.media_id)::int AS usage
            FROM tags t
            LEFT JOIN media_tags mt ON mt.tag_id = t.tag_id
            GROUP BY t.tag_id
            ORDER BY t.kind, t.display_name`;
        logger.trace('DB: getTags');
        const res = await client.query(stm);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getMediaTags(media_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.tag_id, t."name", t.display_name, t.kind, mt.score, mt."source"
            FROM media_tags mt
            JOIN tags t ON t.tag_id = mt.tag_id
            WHERE mt.media_id = $1
            ORDER BY mt."source", mt.score DESC NULLS LAST, t.display_name`;
        logger.trace({ media_id }, 'DB: getMediaTags');
        const res = await client.query(stm, [media_id]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getMediaTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function upsertTag(name, display_name, kind) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO tags ("name", display_name, kind)
            VALUES ($1, $2, $3)
            ON CONFLICT ("name") DO UPDATE SET display_name = EXCLUDED.display_name
            RETURNING *`;
        logger.trace({ name, kind }, 'DB: upsertTag');
        const res = await client.query(stm, [name, display_name, kind]);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function addMediaTag(media_id, tag_id, score, source) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO media_tags (media_id, tag_id, score, "source")
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (media_id, tag_id)
            DO UPDATE SET score = EXCLUDED.score, "source" = EXCLUDED."source"`;
        logger.trace({ media_id, tag_id, source }, 'DB: addMediaTag');
        await client.query(stm, [media_id, tag_id, score || null, source]);
    }
    catch(err) {
        dblog.createLog('ERROR DB addMediaTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function removeMediaTag(media_id, tag_id) {
    const client = await pool.connect();
    try {
        const stm = 'DELETE FROM media_tags WHERE media_id = $1 AND tag_id = $2';
        logger.trace({ media_id, tag_id }, 'DB: removeMediaTag');
        await client.query(stm, [media_id, tag_id]);
    }
    catch(err) {
        dblog.createLog('ERROR DB removeMediaTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = { getTags, getMediaTags, upsertTag, addMediaTag, removeMediaTag };
