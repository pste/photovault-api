const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

async function getRoots(onlyEnabled) {
    const client = await pool.connect();
    try {
        let stm = 'SELECT * FROM roots';
        if (onlyEnabled) {
            stm += ' WHERE enabled = true';
        }
        stm += ' ORDER BY "name"';
        logger.trace('DB: getRoots');
        const res = await client.query(stm);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getRoots', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getRoot(root_id) {
    const client = await pool.connect();
    try {
        const stm = 'SELECT * FROM roots WHERE root_id = $1';
        logger.trace({ root_id }, 'DB: getRoot');
        const res = await client.query(stm, [root_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getRoot', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function upsertRoot(name, rel_path) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO roots ("name", rel_path)
            VALUES ($1, $2)
            ON CONFLICT ("name") DO UPDATE SET rel_path = EXCLUDED.rel_path
            RETURNING *`;
        logger.trace({ name, rel_path }, 'DB: upsertRoot');
        const res = await client.query(stm, [name, rel_path]);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertRoot', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Chiude una scansione: aggiorna last_scan e la fotografia del numero di media,
// che al giro successivo alimenta il guard del reconcile.
async function closeScan(root_id, media_count) {
    const client = await pool.connect();
    try {
        const stm = 'UPDATE roots SET last_scan = NOW(), media_count = $2 WHERE root_id = $1';
        logger.trace({ root_id, media_count }, 'DB: closeScan');
        await client.query(stm, [root_id, media_count]);
    }
    catch(err) {
        dblog.createLog('ERROR DB closeScan', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = { getRoots, getRoot, upsertRoot, closeScan };
