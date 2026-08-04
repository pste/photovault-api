// Conversioni difensive per i parametri che arrivano dalla querystring:
// sono sempre stringhe, e un NaN che finisce in una query PostgreSQL
// diventa un errore poco leggibile molto lontano dal punto in cui e' nato.

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
        return fallback;
    }
    return n;
}

function clamp(value, min, max) {
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}

// Normalizza un percorso di cartella relativo: niente slash iniziale,
// sempre uno slash finale. La radice della root e' la stringa vuota.
function normalizeFolderPath(value) {
    let p = (value || '').replace(/\\/g, '/').trim();
    while (p.startsWith('/')) {
        p = p.slice(1);
    }
    if (p.length > 0 && !p.endsWith('/')) {
        p = p + '/';
    }
    return p;
}

// Percorsi degli antenati di una cartella, dal primo livello fino a se stessa.
// "2019/Barcellona/" => ["2019/", "2019/Barcellona/"]
// Si calcola qui invece che con una CTE ricorsiva: l'elenco risultante colpisce
// direttamente l'indice unique (root_id, path).
function ancestorPaths(folderPath) {
    const parts = normalizeFolderPath(folderPath).split('/').filter((s) => s.length > 0);
    const out = [];
    let acc = '';
    for (const part of parts) {
        acc = acc + part + '/';
        out.push(acc);
    }
    return out;
}

module.exports = { toInt, clamp, normalizeFolderPath, ancestorPaths };
