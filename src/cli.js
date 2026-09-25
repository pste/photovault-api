// Gestione degli utenti da riga di comando. Non esiste una rotta web per
// crearli: niente pagina di registrazione da proteggere. Sul cluster:
//
//   kubectl -n photovault exec -it deploy/api -- node app.js user add <nome>
//
// La password si chiede senza mostrarla, e non passa mai dalla riga di
// comando: finirebbe nella cronologia della shell e nella lista dei processi.
const readline = require('node:readline');
const users = require('./dbmodels/users');
const passwords = require('./passwords');
const pool = require('./dbmodels/dbpool');

const MIN_LENGTH = 10;

const USAGE = `uso: node app.js user <comando>
  add <nome>      crea un utente, chiede la password
  passwd <nome>   cambia la password
  del <nome>      elimina l'utente e chiude le sue sessioni
  list            elenca gli utenti`;

// Da terminale la password non si vede mentre si scrive. Senza terminale --
// uno script che la passa sullo stdin -- si legge la prima riga.
function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
        if (process.stdin.isTTY) {
            rl._writeToOutput = (text) => {
                if (text.includes(question)) {
                    rl.output.write(text);
                }
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            if (process.stdin.isTTY) {
                process.stdout.write('\n');
            }
            resolve(answer);
        });
    });
}

async function askNewPassword() {
    const first = await ask('Password: ');
    if (first.length < MIN_LENGTH) {
        throw new Error(`la password deve avere almeno ${MIN_LENGTH} caratteri`);
    }
    if (process.stdin.isTTY) {
        const second = await ask('Ripeti la password: ');
        if (second !== first) {
            throw new Error('le due password non coincidono');
        }
    }
    return passwords.hashPassword(first);
}

async function userCommand(args) {
    const [command, name] = args;
    if (command === 'list') {
        for (const user of await users.listUsers()) {
            const last = user.last_login ? user.last_login.toISOString() : 'mai';
            console.log(`${user.username}\tcreato ${user.created.toISOString()}\tultimo login ${last}`);
        }
        return;
    }
    if (!name || !['add', 'passwd', 'del'].includes(command)) {
        throw new Error(USAGE);
    }
    if (command === 'add') {
        if (await users.getUserByName(name)) {
            throw new Error(`l'utente ${name} esiste gia'`);
        }
        await users.createUser(name, await askNewPassword());
        console.log(`utente ${name} creato`);
    }
    else if (command === 'passwd') {
        if (!await users.getUserByName(name)) {
            throw new Error(`l'utente ${name} non esiste`);
        }
        await users.setPassword(name, await askNewPassword());
        console.log(`password di ${name} cambiata`);
    }
    else if (!await users.deleteUser(name)) {
        throw new Error(`l'utente ${name} non esiste`);
    }
    else {
        console.log(`utente ${name} eliminato, sessioni chiuse`);
    }
}

async function run(args) {
    try {
        if (args[0] !== 'user') {
            throw new Error(USAGE);
        }
        await userCommand(args.slice(1));
        process.exitCode = 0;
    }
    catch(err) {
        console.error(err.message);
        process.exitCode = 1;
    }
    finally {
        await pool.end();
    }
}

module.exports = { run };
