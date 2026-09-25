const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Sessioni web, store di @fastify/session: in database perche' un riavvio del
// pod API non sloggi tutti.

async function query(label, stm, pars) {
    const client = await pool.connect();
    try {
        logger.trace({ label }, 'DB: sessions');
        return await client.query(stm, pars);
    }
    catch(err) {
        dblog.createLog(`ERROR DB ${label}`, err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Una sessione scaduta non si restituisce: la pulizia vera e' al login, e fino
// ad allora la riga puo' restare, ma non deve piu' valere.
async function getSession(sid) {
    const res = await query('getSession',
        'SELECT data FROM sessions WHERE sid = $1 AND expires > NOW()', [sid]);
    return res.rows[0] ? res.rows[0].data : null;
}

async function setSession(sid, data, expires) {
    await query('setSession', `
        INSERT INTO sessions (sid, data, expires) VALUES ($1, $2, $3)
        ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires`,
    [sid, data, expires]);
}

async function deleteSession(sid) {
    await query('deleteSession', 'DELETE FROM sessions WHERE sid = $1', [sid]);
}

async function deleteExpiredSessions() {
    const res = await query('deleteExpiredSessions', 'DELETE FROM sessions WHERE expires <= NOW()', []);
    return res.rowCount;
}

module.exports = { getSession, setSession, deleteSession, deleteExpiredSessions };
