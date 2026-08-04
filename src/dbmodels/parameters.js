const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Colonne modificabili dalla pagina Impostazioni. L'elenco e' esplicito apposta:
// evita che una chiave arbitraria nel body finisca in un UPDATE.
const EDITABLE = [
    'cron_scan', 'cron_label', 'cron_dedup',
    'thumb_small_px', 'thumb_medium_px',
    'clip_min_score', 'dedup_max_distance', 'page_size',
];

async function getParameters() {
    const client = await pool.connect();
    try {
        const stm = 'SELECT * FROM parameters ORDER BY parameters_id LIMIT 1';
        logger.trace('DB: getParameters');
        const res = await client.query(stm);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getParameters', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function saveParameters(values) {
    const fields = EDITABLE.filter((key) => values[key] !== undefined);
    if (fields.length === 0) {
        return await getParameters();
    }
    const client = await pool.connect();
    try {
        const sets = fields.map((key, i) => `${key} = $${i + 1}`);
        const pars = fields.map((key) => values[key]);
        const stm = `
            UPDATE parameters SET ${sets.join(', ')}
            WHERE parameters_id = (SELECT min(parameters_id) FROM parameters)
            RETURNING *`;
        logger.trace(pars, 'DB: saveParameters');
        const res = await client.query(stm, pars);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB saveParameters', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = { getParameters, saveParameters };
