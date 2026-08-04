const server = require('./src/server');

async function start() {
    await server.run();
}

start()
