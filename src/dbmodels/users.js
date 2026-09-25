const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Utenti. Tutti vedono la stessa libreria: nessun ruolo. Si creano da riga di
// comando (node app.js user add), mai da una rotta web.

async function query(label, stm, pars) {
    const client = await pool.connect();
    try {
        logger.trace({ label }, 'DB: users');
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

// Il nome si confronta senza distinzione di maiuscole, come l'indice unico.
async function getUserByName(username) {
    const res = await query('getUserByName',
        'SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    return res.rows[0] || null;
}

async function createUser(username, passwordHash) {
    const res = await query('createUser',
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING user_id, username, created',
        [username, passwordHash]);
    return res.rows[0];
}

async function setPassword(username, passwordHash) {
    const res = await query('setPassword',
        'UPDATE users SET password_hash = $2 WHERE lower(username) = lower($1)', [username, passwordHash]);
    return res.rowCount > 0;
}

// Eliminare un utente ne chiude anche le sessioni: altrimenti chi ha gia'
// fatto login resterebbe dentro fino alla scadenza del cookie.
async function deleteUser(username) {
    const res = await query('deleteUser',
        'DELETE FROM users WHERE lower(username) = lower($1) RETURNING user_id', [username]);
    if (res.rows[0]) {
        await query('deleteUserSessions',
            `DELETE FROM sessions WHERE (data -> 'user' ->> 'user_id')::int = $1`, [res.rows[0].user_id]);
    }
    return res.rowCount > 0;
}

async function listUsers() {
    const res = await query('listUsers',
        'SELECT user_id, username, created, last_login FROM users ORDER BY username', []);
    return res.rows;
}

async function touchLogin(user_id) {
    await query('touchLogin', 'UPDATE users SET last_login = NOW() WHERE user_id = $1', [user_id]);
}

module.exports = { getUserByName, createUser, setPassword, deleteUser, listUsers, touchLogin };
