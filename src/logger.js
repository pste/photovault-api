const pino = require('pino');

const isDev = (process.env.NODE_ENV !== 'production');

const options = {
    level: process.env.LOG_LEVEL || 'info',
};

// In sviluppo si formatta per la lettura umana; in produzione resta JSON,
// che e' quello che si vuole leggere con kubectl logs.
if (isDev) {
    options.transport = {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    };
}

module.exports = pino(options);
