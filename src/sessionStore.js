const logger = require('./logger');
const sessions = require('./dbmodels/sessions');

// Store di @fastify/session su PostgreSQL. Il MemoryStore predefinito perde
// tutte le sessioni a ogni riavvio del pod API, cioe' sloggherebbe tutti a ogni
// rilascio. L'interfaccia e' a callback, quella di express-session.
//
// Stessa forma di reimagined-disco.

function expiresOf(session) {
    const expires = session && session.cookie && session.cookie.expires;
    return expires ? new Date(expires) : new Date(Date.now() + 24 * 3600 * 1000);
}

const sessionStore = {
    get(sid, callback) {
        sessions.getSession(sid)
            .then((data) => callback(null, data))
            .catch((err) => {
                logger.error(err, 'sessionStore: get fallita');
                callback(err);
            });
    },

    // Si salvano solo le sessioni di un utente loggato: una sessione vuota,
    // creata per un cookie scaduto o sconosciuto, sarebbe una riga inutile.
    set(sid, session, callback) {
        if (!session || !session.user) {
            callback();
            return;
        }
        sessions.setSession(sid, JSON.stringify(session), expiresOf(session))
            .then(() => callback())
            .catch((err) => {
                logger.error(err, 'sessionStore: set fallita');
                callback(err);
            });
    },

    destroy(sid, callback) {
        sessions.deleteSession(sid)
            .then(() => callback())
            .catch((err) => {
                logger.error(err, 'sessionStore: destroy fallita');
                callback(err);
            });
    },
};

module.exports = sessionStore;
