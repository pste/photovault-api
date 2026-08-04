const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

async function getJobs() {
    const client = await pool.connect();
    try {
        const stm = 'SELECT * FROM jobs ORDER BY "when" DESC LIMIT 200';
        logger.trace('DB: getJobs');
        const res = await client.query(stm);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getJobs', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function deleteJob(job_id) {
    const client = await pool.connect();
    try {
        const stm = 'DELETE FROM jobs WHERE job_id = $1';
        logger.trace({ job_id }, 'DB: deleteJob');
        await client.query(stm, [job_id]);
    }
    catch(err) {
        dblog.createLog('ERROR DB deleteJob', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Prende in carico atomicamente il job pendente piu' vecchio, marcandolo running.
//
// Il filtro "name" = ANY($1) e' OBBLIGATORIO e non e' un'ottimizzazione: qui,
// a differenza di reimagined-disco, ci sono piu' pod che pollano la stessa coda
// (Go e Python). Senza il filtro il primo pod che si sveglia prende anche i job
// dell'altro, non trova l'handler e li marca 'error' -- il labeling non
// girerebbe mai, e senza alcun errore visibile.
async function claimNextJob(names) {
    const client = await pool.connect();
    try {
        const stm = `
            UPDATE jobs SET status = 'running', started = NOW()
            WHERE job_id = (
                SELECT job_id FROM jobs
                WHERE status = 'pending'
                  AND "when" <= NOW()
                  AND "name" = ANY($1)
                  AND "name" NOT IN (SELECT "name" FROM jobs WHERE status = 'running')
                ORDER BY "when" ASC
                LIMIT 1
            )
            RETURNING *`;
        logger.trace({ names }, 'DB: claimNextJob');
        const res = await client.query(stm, [names]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB claimNextJob', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function updateJobStatus(job_id, status, result) {
    const client = await pool.connect();
    try {
        const stm = 'UPDATE jobs SET status = $2, ended = NOW(), "result" = $3 WHERE job_id = $1';
        const pars = [job_id, status, result || null];
        logger.trace(pars, 'DB: updateJobStatus');
        await client.query(stm, pars);
    }
    catch(err) {
        dblog.createLog('ERROR DB updateJobStatus', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Tutta la creazione di job passa da qui. L'indice parziale
// jobs_one_pending_per_name ammette un solo job pendente per nome, quindi
// ricrearne uno gia' in coda ne sposta il "when" invece di dare errore 23505.
async function upsertPendingJob(name, when) {
    const client = await pool.connect();
    try {
        const stm = `
            INSERT INTO jobs ("name", "when", "status")
            VALUES ($1, $2, 'pending')
            ON CONFLICT ("name") WHERE "status" = 'pending'
            DO UPDATE SET "when" = EXCLUDED."when"
            RETURNING *`;
        const pars = [name, when];
        logger.trace(pars, 'DB: upsertPendingJob');
        const res = await client.query(stm, pars);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertPendingJob', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = { getJobs, deleteJob, claimNextJob, updateJobStatus, upsertPendingJob };
