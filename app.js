// "node app.js" avvia il server; "node app.js user ..." gestisce gli utenti
// (vedi src/cli.js) senza avviare niente.
async function start() {
    if (process.argv[2] === 'user') {
        await require('./src/cli').run(process.argv.slice(2));
        return;
    }
    await require('./src/server').run();
}

start();
