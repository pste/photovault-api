const path = require('node:path');

// Sottocartella riservata a photovault dentro la share. Va esclusa dallo scan
// e da eventuali backup del NAS: contiene solo dati rigenerabili.
const PRIVATE_DIR = '.photovault';

function mediaRoot() {
    return process.env.MEDIA_ROOT || '/data/photos';
}

// Le thumbnail sono distribuite su 256 sottocartelle. CIFS degrada male oltre
// qualche migliaio di file per directory, e due livelli di shard costerebbero
// 65.000 mkdir per nulla.
function thumbShard(mediaId) {
    return (mediaId % 256).toString(16).padStart(2, '0');
}

// .photovault/thumbs/<shard>/<media_id>_<s|m>.jpg
function thumbPath(mediaId, size) {
    const name = `${mediaId}_${size}.jpg`;
    return path.join(mediaRoot(), PRIVATE_DIR, 'thumbs', thumbShard(mediaId), name);
}

// Percorso assoluto di un media a partire dalle sue coordinate in DB.
// Il mount (MEDIA_ROOT) e' una proprieta' del pod, non un dato: nel database
// stanno solo pezzi relativi (rel_path della root + path della cartella).
function originalPath(relPath, folderPath, fileName) {
    return path.join(mediaRoot(), relPath || '', folderPath || '', fileName);
}

// Difesa contro il path traversal: qualunque percorso costruito da input
// esterno deve restare dentro la root prima di essere aperto.
function isInsideRoot(candidate) {
    const root = path.resolve(mediaRoot());
    const resolved = path.resolve(candidate);
    return (resolved === root || resolved.startsWith(root + path.sep));
}

module.exports = { PRIVATE_DIR, mediaRoot, thumbShard, thumbPath, originalPath, isInsideRoot };
