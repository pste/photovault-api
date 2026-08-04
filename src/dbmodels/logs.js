const pool = require('./dbpool');

// In un sistema guidato da cron nessuno guarda lo stdout: questa tabella e'
// l'unico modo in cui gli errori diventano visibili in UI.
// Non rilancia mai: se anche il log fallisce, non deve nascondere l'errore vero.
async function createLog(message, detail) {
    try {
        const stm = 'INSERT INTO logs ("message", "detail") VALUES ($1, $2)';
        const text = (detail instanceof Error) ? detail.message : detail;
        await pool.query(stm, [message, text || null]);
    }
    catch(err) {
        console.error('DB: createLog failed', err);
    }
}

async function getLogs(limit) {
    const stm = 'SELECT * FROM logs ORDER BY "when" DESC LIMIT $1';
    const res = await pool.query(stm, [limit || 200]);
    return res.rows;
}

module.exports = { createLog, getLogs };
