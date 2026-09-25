// Hash delle password con scrypt, dalla libreria standard di Node: nessuna
// dipendenza in piu'. La password non si salva mai, ne' in database ne' nei log.
//
// Formato: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>. I parametri viaggiano
// con l'hash, cosi' alzarli in futuro non invalida quelli gia' salvati: ogni
// verifica usa i parametri con cui quell'hash e' stato fatto.
const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

function derive(password, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEYLEN, params, (err, key) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(key);
            }
        });
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await derive(password, salt, PARAMS);
    return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

// Il confronto e' a tempo costante: un confronto normale si ferma al primo
// byte diverso, e il tempo di risposta direbbe quanti byte sono giusti.
async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
        return false;
    }
    const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
    const expected = Buffer.from(parts[5], 'base64');
    const key = await derive(password, Buffer.from(parts[4], 'base64'), params);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Per un utente che non esiste si calcola comunque un hash: altrimenti la
// risposta arriverebbe prima, e dal tempo si capirebbe quali nomi esistono.
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'));

async function verifyMissingUser(password) {
    await verifyPassword(password, await DUMMY);
    return false;
}

module.exports = { hashPassword, verifyPassword, verifyMissingUser };
