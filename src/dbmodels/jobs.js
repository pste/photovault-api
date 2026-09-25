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

// Quanto puo' restare muto un job prima di essere considerato orfano.
// Generoso di proposito: un job vivo tocca il proprio battito a ogni blocco di
// lavoro -- per thumbs, ogni cento anteprime, cioe' meno di un minuto -- quindi
// mezz'ora di silenzio significa che il pod non c'e' piu'. La soglia non puo'
// invece guardare da quanto il job e' partito: thumbs su 338.000 file gira
// legittimamente per giorni.
const STALE_MINUTES = parseInt(process.env.JOB_STALE_MINUTES || '30', 10);

// Recupera i job rimasti 'running' senza che nessun pod li chiuda.
//
// Gira qui dentro, e non in un job dedicato, per due motivi: e' esattamente il
// momento in cui la cosa conta -- qualcuno sta chiedendo lavoro -- e un reaper
// che fosse a sua volta un job potrebbe morire lasciando appeso se' stesso.
async function reapStaleJobs(client) {
    const stm = `
        UPDATE jobs
        SET status = 'error',
            ended = NOW(),
            "result" = 'job orfano: nessun battito da oltre ' || $1 || ' minuti'
        WHERE status = 'running'
          AND COALESCE(heartbeat, started) < NOW() - ($1 || ' minutes')::interval
        RETURNING job_id, "name"`;
    const res = await client.query(stm, [STALE_MINUTES]);
    for (const row of res.rows) {
        logger.warn({ job_id: row.job_id, name: row.name }, 'job orfano recuperato');
        dblog.createLog('JOB ORFANO', `${row.name} (job ${row.job_id}) senza battito, rimesso in errore`);
    }
    return res.rows.length;
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
        await reapStaleJobs(client);

        // FOR UPDATE SKIP LOCKED e il secondo status = 'pending' servono a due
        // claim simultanei. Senza, il secondo aspettava il lock della riga, poi
        // ricontrollava solo job_id -- ancora vero -- e riceveva lo stesso job
        // del primo, con started riscritto: due pod sullo stesso lavoro.
        const stm = `
            UPDATE jobs SET status = 'running', started = NOW(), heartbeat = NOW()
            WHERE status = 'pending'
              AND job_id = (
                SELECT job_id FROM jobs
                WHERE status = 'pending'
                  AND "when" <= NOW()
                  AND "name" = ANY($1)
                  AND "name" NOT IN (SELECT "name" FROM jobs WHERE status = 'running')
                ORDER BY "when" ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
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

// Segno di vita di un job in esecuzione. Il pod lo manda a ogni blocco di
// lavoro concluso: e' cio' che distingue un job lento da un job orfano.
async function touchJob(job_id) {
    const client = await pool.connect();
    try {
        const res = await client.query(
            `UPDATE jobs SET heartbeat = NOW() WHERE job_id = $1 AND status = 'running'`,
            [job_id]);
        return res.rowCount > 0;
    }
    catch(err) {
        dblog.createLog('ERROR DB touchJob', err);
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

module.exports = { getJobs, deleteJob, claimNextJob, touchJob, updateJobStatus, upsertPendingJob };
