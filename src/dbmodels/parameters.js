const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Colonne modificabili dalla pagina Impostazioni, con l'intervallo ammesso.
// L'elenco e' esplicito apposta: evita che una chiave arbitraria nel body
// finisca in un UPDATE.
//
// Solo i parametri che qualcuno legge davvero. Gli altri -- cron_*, thumb_*_px,
// clip_min_score, page_size -- restano in tabella come documentazione, e la UI
// li mostra in sola lettura: gli orari vivono nei CronJob, le dimensioni delle
// anteprime nel pod scan.
//
// Gli intervalli non sono pignoleria:
// - un trash_retention_days negativo sposta la scadenza nel futuro, e il
//   trashpurge successivo cancella definitivamente tutto il cestino;
// - una dedup_max_distance alta fa restituire a findSimilarPairs quasi ogni
//   coppia dell'archivio, in memoria nell'API. Oltre 16 bit su 64 due immagini
//   non si somigliano piu' in nessun senso utile.
const EDITABLE = {
    dedup_max_distance: { min: 0, max: 16 },
    trash_retention_days: { min: 1, max: 3650 },
};

// Restituisce l'errore del primo valore fuori regola, o null.
function invalidReason(values) {
    for (const [key, range] of Object.entries(EDITABLE)) {
        if (values[key] === undefined) {
            continue;
        }
        const value = Number(values[key]);
        if (!Number.isInteger(value) || value < range.min || value > range.max) {
            return `${key}: atteso un intero fra ${range.min} e ${range.max}`;
        }
    }
    return null;
}

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
    const fields = Object.keys(EDITABLE).filter((key) => values[key] !== undefined);
    if (fields.length === 0) {
        return await getParameters();
    }
    const client = await pool.connect();
    try {
        const sets = fields.map((key, i) => `${key} = $${i + 1}`);
        const pars = fields.map((key) => Number(values[key]));
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

module.exports = { getParameters, saveParameters, invalidReason };
