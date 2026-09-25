const pg = require('pg');
const logger = require('../logger');
const { Pool } = pg;

const config = {
    max: 20,
    idleTimeoutMillis: 20000,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: process.env.PGDATABASE,
}

const pool = new Pool(config);

// Un client inattivo nel pool che perde la connessione -- Postgres riavviato,
// il pod spostato -- emette 'error' sul pool. Senza un ascoltatore Node lo
// tratta come eccezione non gestita e il processo esce: un riavvio di Postgres
// abbatteva anche l'API. Il client guasto viene gia' scartato dal pool, e alla
// richiesta successiva se ne apre uno nuovo: basta registrarlo.
pool.on('error', (err) => {
    logger.warn({ err: err.message }, 'connessione inattiva al database persa');
});

module.exports = pool;
