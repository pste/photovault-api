const pg = require('pg');
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

module.exports = pool;
