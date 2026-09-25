const logger = require('./logger');
const utils = require('./utils');

const roots = require('./dbmodels/roots');
const folders = require('./dbmodels/folders');
const media = require('./dbmodels/media');
const tags = require('./dbmodels/tags');
const jobs = require('./dbmodels/jobs');
const parameters = require('./dbmodels/parameters');
const duplicates = require('./dbmodels/duplicates');
const trash = require('./dbmodels/trash');
const others = require('./dbmodels/others');
const livephotos = require('./dbmodels/livephotos');
const dblog = require('./dbmodels/logs');
const dedup = require('./dedup');

// Sotto questa frazione di media ritrovati, il reconcile si rifiuta di lavorare.
// Vedi refuseReason() piu' sotto per il perche'.
const RECONCILE_MIN_RATIO = 0.9;

// Quante anteprime mostrare nel mosaico del tile di una cartella.
const FOLDER_PREVIEWS = 4;

/////////////////////////////////////////////////////////////////

// Contenuto di una cartella: breadcrumb, sottocartelle (con le anteprime per il
// mosaico) e media paginati. E' la query che alimenta la pagina principale.
async function browseFolder(folder_id, root_id, limit, offset) {
    let folder = null;
    let rootId = root_id;

    if (folder_id) {
        folder = await folders.getFolder(folder_id);
        if (!folder) {
            return null;
        }
        rootId = folder.root_id;
    }
    else {
        // Senza folder si apre la cartella radice della root: ogni root ne ha
        // esattamente una, con path vuoto. Serve perche' i file che stanno
        // direttamente nella radice della share devono comunque avere una
        // cartella (media.folder_id e' NOT NULL), e perche' cosi' la radice si
        // naviga con lo stesso codice di qualunque altra cartella.
        folder = await folders.getFolderByPath(rootId, '');
    }

    // Una root mai scansionata non ha ancora la sua cartella radice: si
    // risponde con una vista vuota invece che con un 404.
    if (!folder) {
        return { folder: null, breadcrumb: [], subfolders: [], media: [], total: 0, limit, offset };
    }

    const subfolders = await folders.getSubfolders(rootId, folder.folder_id);
    const breadcrumb = await folders.getBreadcrumb(rootId, folder.path);

    // Anteprime e conteggi: una query sola per tutte le sottocartelle, non una
    // per tile. I conteggi si calcolano qui e non da colonne denormalizzate,
    // cosi' non esiste un intervallo in cui il numero mostrato e' vecchio.
    const ids = subfolders.map((f) => f.folder_id);
    const previews = await folders.getFolderPreviews(ids, FOLDER_PREVIEWS);
    const counts = await folders.getFolderCounts(ids);
    for (const sub of subfolders) {
        sub.previews = previews
            .filter((p) => p.folder_id === sub.folder_id)
            .map((p) => ({ media_id: p.media_id, v: Math.floor(new Date(p.updated).getTime() / 1000) }));

        const row = counts.find((c) => c.folder_id === sub.folder_id);
        sub.media_count = row ? Number(row.media_count) : 0;
        sub.sub_count = row ? Number(row.sub_count) : 0;
    }

    const items = await media.getMediaInFolder(folder.folder_id, limit, offset);
    const total = await media.countMediaInFolder(folder.folder_id);

    return { folder, breadcrumb, subfolders, media: items, total, limit, offset };
}

async function getMediaDetail(media_id) {
    const item = await media.getMedia(media_id);
    if (!item) {
        return null;
    }
    item.tags = await tags.getMediaTags(media_id);
    return item;
}

async function search(filters, limit, offset) {
    const items = await media.search(filters, limit, offset);
    const total = await media.countSearch(filters);
    return { media: items, total, limit, offset };
}

/////////////////////////////////////////////////////////////////
// Scansione

// Crea (o ritrova) una cartella a partire dal suo percorso relativo alla root.
// Il parent viene risolto qui dal percorso, cosi' lo scan non deve tenere traccia
// degli id mentre cammina: manda solo il path.
async function registerFolder(root_id, folderPath) {
    const path = utils.normalizeFolderPath(folderPath);

    // Percorso vuoto = la cartella radice della root. Esiste sempre, e' il
    // genitore di tutto e ospita i file che stanno direttamente nella share.
    if (path === '') {
        const root = await roots.getRoot(root_id);
        const name = root ? root.name : 'root';
        return await folders.upsertFolder(root_id, null, name, '', 0);
    }

    // Si percorre la catena dal primo livello fino in fondo, creando (o
    // ritrovando) ogni antenato con il SUO parent corretto.
    // Non si puo' creare l'antenato con parent_id=null e basta: l'ON CONFLICT
    // di upsertFolder riscrive parent_id, quindi passare null azzererebbe il
    // legame di una cartella intermedia gia' collegata, spezzando l'albero.
    // La catena parte SEMPRE dalla cartella radice, cosi' il primo livello ha un
    // genitore vero e l'albero e' collegato per intero.
    const rootFolder = await registerFolder(root_id, '');
    const parts = path.split('/').filter((s) => s.length > 0);
    let parent_id = rootFolder.folder_id;
    let acc = '';
    let folder = rootFolder;

    for (let i = 0; i < parts.length; i++) {
        acc = acc + parts[i] + '/';
        folder = await folders.upsertFolder(root_id, parent_id, parts[i], acc, i + 1);
        parent_id = folder.folder_id;
    }

    return folder;
}

async function ingestMedia(items) {
    return await media.upsertMediaBatch(items);
}

// I file che photovault non gestisce. Lo scan li manda a parte, in un batch
// suo: non entrano in media perche' non hanno una pipeline da percorrere --
// nessuno fara' mai la thumbnail di un .psd.
async function ingestOthers(items) {
    return await others.upsertBatch(items);
}

// Risultato del job dei luoghi: i tag di ogni media e la chiusura della coda.
//
// I tag arrivano per nome, non per id, come quelli di CLIP: il vocabolario dei
// toponimi vive in photovault-label -- e' GeoNames -- non in questo database.
async function applyPlaces(items) {
    for (const item of items) {
        if (item.tags && item.tags.length > 0) {
            await applyTags(item.media_id, item.tags, item.source || 'geo');
        }
    }
    return await media.setPlaceResults(items);
}

// Perche' il guard: una share CIFS irraggiungibile, o montata a meta', restituisce
// una directory vuota. A livello di syscall e' indistinguibile da "l'utente ha
// cancellato tutte le foto". Senza questo controllo un solo mount ballerino
// cancellerebbe l'intero indice.
function refuseReason(seen, known) {
    if (known > 0 && seen < known * RECONCILE_MIN_RATIO) {
        return `reconcile rifiutato: visti ${seen} media su ${known} noti`;
    }
    return null;
}

// Chiude una scansione: marca come mancanti i media -- e i file non gestiti --
// che non sono stati rivisti, e memorizza quanti ne ha contati la scansione.
async function reconcileScan(root_id, scanStartedAt) {
    const root = await roots.getRoot(root_id);
    if (!root) {
        throw new Error(`reconcileScan: root ${root_id} inesistente`);
    }

    const seen = await media.countSeenSince(root_id, scanStartedAt);
    const known = await media.countKnown(root_id);
    const refused = refuseReason(seen, known);
    if (refused) {
        logger.error({ root_id, seen, known }, refused);
        dblog.createLog('RECONCILE REFUSED', refused);
        return { refused: true, reason: refused, seen, known };
    }

    const missing = await media.markMissing(root_id, scanStartedAt);

    // I file non gestiti seguono la sorte dei media: il guard che li protegge e'
    // lo stesso, perche' se la share fosse mezza montata avremmo gia' rifiutato
    // qui sopra e non saremmo arrivati a questa riga.
    const missingOthers = await others.markMissing(root_id, scanStartedAt);
    await roots.closeScan(root_id, seen);

    logger.info({ root_id, seen, missing, missingOthers }, 'reconcile completato');
    return { refused: false, seen, missing };
}

/////////////////////////////////////////////////////////////////
// Tag

// I tag applicati dai cron arrivano per nome, non per id: il vocabolario vive
// nel repo di photovault-label, non nel database.
async function applyTags(media_id, list, source) {
    for (const entry of list) {
        const tag = await tags.upsertTag(entry.name, entry.display_name || entry.name, entry.kind || 'scene');
        await tags.addMediaTag(media_id, tag.tag_id, entry.score, source);
    }
}

/////////////////////////////////////////////////////////////////
// Duplicati e cestino

async function rebuildDuplicates() {
    const pars = await parameters.getParameters();
    return await dedup.rebuild(pars.dedup_max_distance);
}

async function getDuplicates(status, kind, limit, offset) {
    const groups = await duplicates.getGroups(status, kind, limit, offset);
    // Le miniature dei primi membri servono a riconoscere il gruppo a colpo
    // d'occhio senza aprirlo.
    for (const group of groups) {
        group.members = await duplicates.getGroupMembers(group.dup_group_id);
    }
    const total = await duplicates.countGroups(status, kind);
    return { groups, total, limit, offset };
}

async function getDuplicateGroup(dup_group_id) {
    const group = await duplicates.getGroup(dup_group_id);
    if (!group) {
        return null;
    }
    group.members = await duplicates.getGroupMembers(dup_group_id);
    return group;
}

// Risolve un gruppo. 'ignore' lo archivia senza toccare i file; 'trash' mette
// in coda lo spostamento di tutti i membri tranne quello da tenere.
//
// L'API non sposta nulla: accoda il lavoro e lascia fare al pod scan, che e'
// l'unico con la share in scrittura. Cosi' un bug qui non puo' danneggiare la
// libreria.
async function resolveDuplicateGroup(dup_group_id, keep_media_id, action) {
    const group = await duplicates.getGroup(dup_group_id);
    if (!group) {
        return null;
    }

    if (action === 'ignore') {
        await duplicates.setGroupStatus(dup_group_id, 'ignored');
        return { dup_group_id, action, cestinati: 0 };
    }

    const members = await duplicates.getGroupMembers(dup_group_id);
    const keeper = keep_media_id || (members.find((m) => m.is_keeper) || {}).media_id;
    if (!keeper) {
        throw new Error('resolveDuplicateGroup: nessun file da tenere indicato');
    }
    if (!members.some((m) => m.media_id === keeper)) {
        throw new Error('resolveDuplicateGroup: il file da tenere non appartiene al gruppo');
    }

    let queued = 0;
    for (const member of members) {
        if (member.media_id !== keeper && await trash.requestTrash(member.media_id)) {
            queued++;
        }
    }

    await duplicates.setGroupStatus(dup_group_id, 'resolved');
    if (queued > 0) {
        await jobs.upsertPendingJob('trashapply', new Date());
    }
    return { dup_group_id, action: 'trash', cestinati: queued, keep_media_id: keeper };
}

// Le cartelle in coda portano con se' l'elenco dei media che contengono: il pod
// scan deve togliere le loro thumbnail, che vivono in .photovault/thumbs/ e non
// si spostano con la rename della cartella.
async function getPendingTrash(limit) {
    const rows = await trash.getPendingTrash(limit);
    for (const row of rows) {
        if (row.folder_id) {
            row.thumb_media_ids = await trash.getFolderMediaIds(row.folder_id);
        }
    }
    return rows;
}

// Quanto c'e' dentro una cartella, escluso cio' che e' gia' in coda di
// cestinamento. Serve alla UI per proporre di togliere la cartella quando si
// svuota: si propone solo se non resta davvero niente.
async function getFolderContents(folder_id) {
    return await folders.getContents(folder_id);
}

async function trashFolders(folder_ids) {
    let queued = 0;
    for (const folder_id of folder_ids || []) {
        const row = await trash.requestTrashFolder(folder_id);
        if (row) {
            queued++;
        }
    }
    if (queued > 0) {
        await jobs.upsertPendingJob('trashapply', new Date());
    }
    return { cestinate: queued };
}

// Cestina dei media scelti a mano dalla UI.
//
// Stessa strada della risoluzione dei duplicati, e non e' un caso: cestinare
// vuol dire mettere in coda: a spostare il file e' il pod scan, l'unico con la
// share in scrittura. Qui dentro non si cancella niente, e nemmeno si sposta.
//
// Un media gia' in cestino non viene accodato due volte -- requestTrash
// restituisce null -- cosi' un doppio clic sul pulsante non genera due
// spostamenti dello stesso file.
async function trashMedia(media_ids, other_ids) {
    let queued = 0;
    for (const media_id of media_ids || []) {
        const row = await trash.requestTrash(media_id);
        if (row) {
            queued++;
        }
    }
    for (const other_id of other_ids || []) {
        const row = await trash.requestTrashOther(other_id);
        if (row) {
            queued++;
        }
    }
    if (queued > 0) {
        await jobs.upsertPendingJob('trashapply', new Date());
    }
    return { cestinati: queued };
}

// Coda del job trashpurge: i giorni di ritenzione sono un parametro, non una
// costante, cosi' si allargano dalla pagina Impostazioni senza ricompilare.
async function getExpiredTrash(limit) {
    const pars = await parameters.getParameters();
    return await trash.getExpiredTrash(pars.trash_retention_days, limit);
}

/////////////////////////////////////////////////////////////////

module.exports = {
    // browse
    browseFolder, getMediaDetail, search,
    getRoots: roots.getRoots,
    getStats: media.getStats,
    // scan
    registerFolder, ingestMedia, ingestOthers, reconcileScan,
    getPending: media.getPending,
    setThumbResults: media.setThumbResults,
    setPlaceResults: media.setPlaceResults,
    applyPlaces,
    upsertRoot: roots.upsertRoot,
    // tag
    applyTags,
    getTags: tags.getTags,
    upsertTag: tags.upsertTag,
    addMediaTag: tags.addMediaTag,
    removeMediaTag: tags.removeMediaTag,
    listTags: tags.listTags,
    getTagKinds: tags.getKinds,
    updateTag: tags.updateTag,
    mergeTags: tags.mergeTags,
    clearTag: tags.clearTag,
    // job
    getJobs: jobs.getJobs,
    deleteJob: jobs.deleteJob,
    touchJob: jobs.touchJob,
    claimNextJob: jobs.claimNextJob,
    updateJobStatus: jobs.updateJobStatus,
    upsertPendingJob: jobs.upsertPendingJob,
    // duplicati
    rebuildDuplicates, getDuplicates, getDuplicateGroup, resolveDuplicateGroup,
    saveHashes: duplicates.saveHashes,
    getDuplicateStats: duplicates.getStats,
    // altri file
    getOthers: others.getOthers,
    countOthers: others.countOthers,
    getOthersStats: others.getStats,
    markNotMedia: others.markNotMedia,
    getOtherDetail: others.getDetail,
    // live photo
    pairLivePhotos: livephotos.pair,
    getLivePhotos: livephotos.list,
    getLivePhotoStats: livephotos.stats,
    getLivePhotoVideoIds: livephotos.videoIds,
    // cestino
    trashMedia, trashFolders, getFolderContents, getExpiredTrash,
    getPendingTrash,
    completeTrash: trash.completeTrash,
    completePurge: trash.completePurge,
    getTrash: trash.getTrash,
    getTrashStats: trash.getTrashStats,
    // parametri e log
    getParameters: parameters.getParameters,
    saveParameters: parameters.saveParameters,
    getLogs: dblog.getLogs,
    // esportata per i test
    refuseReason,
};
