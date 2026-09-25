const fsp = require('node:fs/promises');

const logger = require('./logger');
const fastifyApp = require('fastify');
const cors = require('@fastify/cors');

const db = require('./db');
const paths = require('./paths');
const utils = require('./utils');

const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;

// =============== FASTIFY =============== //

const fastifyOptions = {
    loggerInstance: logger,
    disableRequestLogging: (process.env.DISABLE_REQUEST_LOGGING) ? true : false,
    requestTimeout: 30 * 1000,
}

const fastify = fastifyApp(fastifyOptions);

const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

fastify.register(cors, { origin: (corsOrigins.length > 0) ? corsOrigins : false });

// =============== HELPER =============== //

function paging(query) {
    const limit = utils.clamp(utils.toInt(query.size, DEFAULT_PAGE), 1, MAX_PAGE);
    const page = utils.clamp(utils.toInt(query.page, 0), 0, Number.MAX_SAFE_INTEGER);
    return { limit, offset: page * limit };
}

// Streaming di un file della share, con supporto Range.
//
// Condiviso da media e file non gestiti: sono la stessa operazione, e il Range
// serve a entrambi -- un video si apre a meta', e fra i file non gestiti ci sono
// ISO da 27 GB che nessuno vuole riscaricare da capo dopo un'interruzione.
async function sendOriginal(req, reply, filePath) {
    if (!paths.isInsideRoot(filePath)) {
        return reply.status(400).send({ error: 'percorso non valido' });
    }

    // Un solo file handle per stat e stream: l'esito e' noto prima di iniziare
    // a rispondere (vedi la nota in sendFile), e non c'e' finestra tra il
    // controllo e l'apertura in cui il file possa sparire.
    let handle = null;
    let stat = null;
    try {
        handle = await fsp.open(filePath, 'r');
        stat = await handle.stat();
    }
    catch(err) {
        if (handle) {
            await handle.close();
        }
        const code = (err.code === 'ENOENT') ? 404 : 503;
        return reply.status(code).send({ error: 'file non leggibile' });
    }

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=3600');

    const range = req.headers.range;
    if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = (match && match[1]) ? parseInt(match[1], 10) : 0;
        const end = (match && match[2]) ? parseInt(match[2], 10) : stat.size - 1;

        if (start >= stat.size || end >= stat.size || start > end) {
            await handle.close();
            reply.header('Content-Range', `bytes */${stat.size}`);
            return reply.status(416).send({ error: 'range non valido' });
        }

        reply.status(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('Content-Length', end - start + 1);
        return reply.send(handle.createReadStream({ start, end, autoClose: true }));
    }

    reply.header('Content-Length', stat.size);
    return reply.send(handle.createReadStream({ autoClose: true }));
}

// Invia un file dal disco.
//
// Si apre il file PRIMA di iniziare a rispondere, e non ci si affida a un
// handler 'error' sullo stream: quando l'errore arriva, reply.send(stream) e'
// gia' stato chiamato e la risposta e' partita, quindi un secondo send fallisce
// e abbatte il processo (verificato: bastava una thumbnail mancante).
// Aprendo prima, l'esito e' noto quando la risposta non e' ancora cominciata.
//
// fsp.open e' asincrona e usa il threadpool: a differenza di statSync, contro un
// mount CIFS bloccato non ferma l'event loop.
//
// Gli header passati si applicano solo se il file si apre: una cache
// "immutable" di un anno messa prima valeva anche per il 404 e il 503, e il
// browser teneva l'errore per quella URL anche a file comparso o NAS tornato.
async function sendFile(reply, filePath, mimeType, headers) {
    if (!paths.isInsideRoot(filePath)) {
        return reply.status(400).send({ error: 'percorso non valido' });
    }

    let handle = null;
    try {
        handle = await fsp.open(filePath, 'r');
    }
    catch(err) {
        if (err.code === 'ENOENT') {
            return reply.status(404).send({ error: 'file non trovato' });
        }
        // EIO/ETIMEDOUT: tipicamente la share non risponde. 503 e non 500, cosi'
        // la UI distingue "manca il file" da "manca il NAS".
        logger.error({ err, filePath }, 'sendFile: errore di lettura');
        return reply.status(503).send({ error: 'storage non disponibile' });
    }

    reply.headers(headers || {});
    reply.type(mimeType);
    return reply.send(handle.createReadStream({ autoClose: true }));
}

// =============== ROTTE APERTE =============== //

fastify.register((instance, opts, done) => {

    instance.get('/health', async () => {
        return { status: 'ok' };
    });

    // Stato della share. Alimenta il banner in UI: la navigazione dei metadati
    // funziona anche a NAS spento, perche' vive nel database.
    instance.get('/health/storage', async () => {
        try {
            await fsp.access(paths.mediaRoot());
            return { status: 'ok', root: paths.mediaRoot() };
        }
        catch(err) {
            logger.warn({ err }, 'storage non raggiungibile');
            return { status: 'unavailable', root: paths.mediaRoot(), error: err.code };
        }
    });

    instance.get('/stats', async () => {
        return await db.getStats();
    });

    // ---------- navigazione ----------

    instance.get('/browse/roots', async () => {
        return await db.getRoots(true);
    });

    // Senza folder si mostra il primo livello della root indicata.
    instance.get('/browse/folder', async (req, reply) => {
        const { limit, offset } = paging(req.query);
        const folder_id = utils.toInt(req.query.folder, null);
        const root_id = utils.toInt(req.query.root, null);

        if (!folder_id && !root_id) {
            return reply.status(400).send({ error: 'serve folder oppure root' });
        }

        const data = await db.browseFolder(folder_id, root_id, limit, offset);
        if (!data) {
            return reply.status(404).send({ error: 'cartella non trovata' });
        }
        return data;
    });

    // Cosa e' rimasto dentro una cartella. La UI la interroga dopo aver
    // cestinato dei media, per proporre di togliere anche la cartella se non
    // resta piu' niente -- ne' media, ne' file estranei, ne' sottocartelle.
    instance.get('/folders/:id/contents', async (req, reply) => {
        const folder_id = utils.toInt(req.params.id, null);
        const data = await db.getFolderContents(folder_id);
        if (!data) {
            return reply.status(404).send({ error: 'cartella non trovata' });
        }
        return data;
    });

    instance.get('/media/:id', async (req, reply) => {
        const media_id = utils.toInt(req.params.id, null);
        const item = await db.getMediaDetail(media_id);
        if (!item) {
            return reply.status(404).send({ error: 'media non trovato' });
        }
        return item;
    });

    instance.get('/search', async (req) => {
        const { limit, offset } = paging(req.query);
        const filters = {
            q: req.query.q || null,
            kind: req.query.kind || null,
            from: req.query.from || null,
            to: req.query.to || null,
            tag: req.query.tag || null,
            folderPath: req.query.path || null,
        };
        return await db.search(filters, limit, offset);
    });

    // ---------- file ----------

    // L'URL porta ?v=<updated>: cosi' immutable resta corretto anche se il file
    // cambia mantenendo lo stesso media_id.
    instance.get('/thumb/:id/:size', async (req, reply) => {
        const media_id = utils.toInt(req.params.id, null);
        const size = req.params.size;

        if (!media_id || (size !== 's' && size !== 'm')) {
            return reply.status(400).send({ error: 'parametri non validi' });
        }

        return sendFile(reply, paths.thumbPath(media_id, size), 'image/jpeg', {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': `"${media_id}-${size}-${req.query.v || '0'}"`,
        });
    });

    // Originale, con supporto Range: serve alla riproduzione video e al download.
    instance.get('/media/:id/original', async (req, reply) => {
        const item = await db.getMediaDetail(utils.toInt(req.params.id, null));
        if (!item) {
            return reply.status(404).send({ error: 'media non trovato' });
        }
        return sendOriginal(req, reply,
            paths.originalPath(item.rel_path, item.folder_path, item.file_name));
    });

    // Scaricare un file non gestito e' l'unico modo per sapere cosa sia: la
    // pagina ne mostra percorso e dimensione, ma un .dat da 3 GB si giudica solo
    // aprendolo. Content-Disposition attachment perche' il browser non provi a
    // renderizzare qualcosa che non sa cos'e'.
    instance.get('/others/:id/download', async (req, reply) => {
        const item = await db.getOtherDetail(utils.toInt(req.params.id, null));
        if (!item) {
            return reply.status(404).send({ error: 'file non trovato' });
        }
        reply.header('Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(item.file_name)}`);
        return sendOriginal(req, reply,
            paths.originalPath(item.rel_path, item.path, item.file_name));
    });

    // ---------- tag ----------

    instance.get('/tags', async () => {
        return await db.getTags();
    });

    // ---------- gestione dei tag ----------

    instance.get('/tags/manage', async (req) => {
        const blocked = req.query.blocked === undefined ? null : req.query.blocked === 'true';
        return await db.listTags({ kind: req.query.kind || null, q: req.query.q || null, blocked });
    });

    instance.get('/tags/kinds', async () => {
        return await db.getTagKinds();
    });

    instance.patch('/tags/:id', async (req, reply) => {
        const tag_id = utils.toInt(req.params.id, null);
        if (!tag_id) {
            return reply.status(400).send({ error: 'tag non valido' });
        }
        const { display_name, kind, blocked } = req.body || {};
        if (display_name !== undefined && String(display_name).trim().length === 0) {
            return reply.status(400).send({ error: 'il nome non puo\' essere vuoto' });
        }
        const tag = await db.updateTag(tag_id, {
            display_name: display_name === undefined ? null : String(display_name).trim(),
            kind: kind === undefined ? null : kind,
            blocked: blocked === undefined ? null : Boolean(blocked),
        });
        if (!tag) {
            return reply.status(404).send({ error: 'tag inesistente' });
        }
        return tag;
    });

    instance.post('/tags/:id/merge', async (req, reply) => {
        const fromId = utils.toInt(req.params.id, null);
        const intoId = utils.toInt((req.body || {}).into, null);
        if (!fromId || !intoId) {
            return reply.status(400).send({ error: 'servono due tag' });
        }
        if (fromId === intoId) {
            return reply.status(400).send({ error: 'un tag non si fonde con se stesso' });
        }
        return await db.mergeTags(fromId, intoId);
    });

    // Non e' una DELETE perche' la riga non sparisce: le assegnazioni si
    // tolgono e il tag resta bloccato, che e' l'unico modo perche' non torni.
    instance.post('/tags/:id/clear', async (req, reply) => {
        const tag_id = utils.toInt(req.params.id, null);
        if (!tag_id) {
            return reply.status(400).send({ error: 'tag non valido' });
        }
        return await db.clearTag(tag_id);
    });

    instance.post('/media/:id/tags', async (req, reply) => {
        const media_id = utils.toInt(req.params.id, null);
        const { add, remove } = req.body || {};

        if (!media_id) {
            return reply.status(400).send({ error: 'media non valido' });
        }
        for (const name of (add || [])) {
            const tag = await db.upsertTag(name, name, 'user');
            await db.addMediaTag(media_id, tag.tag_id, null, 'user');
        }
        for (const tag_id of (remove || [])) {
            await db.removeMediaTag(media_id, tag_id);
        }
        return { ok: true };
    });

    // ---------- duplicati ----------

    instance.get('/duplicates', async (req) => {
        const { limit, offset } = paging(req.query);
        return await db.getDuplicates(
            req.query.status || 'open', req.query.kind || null, limit, offset);
    });

    instance.get('/duplicates/stats', async () => {
        return await db.getDuplicateStats();
    });

    instance.get('/duplicates/:id', async (req, reply) => {
        const group = await db.getDuplicateGroup(utils.toInt(req.params.id, null));
        if (!group) {
            return reply.status(404).send({ error: 'gruppo non trovato' });
        }
        return group;
    });

    // action: 'trash' sposta nel cestino tutto tranne keep_media_id,
    //         'ignore' archivia il gruppo senza toccare i file.
    instance.post('/duplicates/:id/resolve', async (req, reply) => {
        const { keep_media_id, action } = req.body || {};
        if (action !== 'trash' && action !== 'ignore') {
            return reply.status(400).send({ error: "action deve essere 'trash' oppure 'ignore'" });
        }
        try {
            const outcome = await db.resolveDuplicateGroup(
                utils.toInt(req.params.id, null), utils.toInt(keep_media_id, null), action);
            if (!outcome) {
                return reply.status(404).send({ error: 'gruppo non trovato' });
            }
            return outcome;
        }
        catch(err) {
            return reply.status(400).send({ error: err.message });
        }
    });

    // ---------- altri file ----------

    // I file che photovault non gestisce: ne' immagini ne' video. Servono per
    // sapere cosa c'e' sulla share oltre alla libreria, e per fare pulizia.
    instance.get('/others', async (req) => {
        const { limit, offset } = paging(req.query);
        const ext = req.query.ext || null;
        const items = await db.getOthers({ ext, sort: req.query.sort, limit, offset });
        const total = await db.countOthers(ext);
        return { items, total, limit, offset };
    });

    instance.get('/others/stats', async () => {
        return await db.getOthersStats();
    });

    // ---------- live photo ----------

    instance.get('/livephotos', async (req) => {
        const { limit, offset } = paging(req.query);
        const items = await db.getLivePhotos(limit, offset);
        const stats = await db.getLivePhotoStats();
        return { items, total: stats.coppie, bytes_video: stats.bytes_video, limit, offset };
    });

    // Cestina il video di ogni coppia e tiene la foto. Gli id li sceglie il
    // database e non il client: l'azione vale su tutte le coppie, non solo su
    // quelle della pagina che si sta guardando.
    instance.post('/livephotos/trash-videos', async () => {
        const ids = await db.getLivePhotoVideoIds();
        if (ids.length === 0) {
            return { cestinati: 0 };
        }
        return await db.trashMedia(ids);
    });

    // ---------- cestino ----------

    instance.get('/trash', async (req) => {
        const { limit, offset } = paging(req.query);
        return await db.getTrash(req.query.status || null, limit, offset);
    });

    // Cestina media scelti a mano dalla griglia. Accoda soltanto: a spostare i
    // file e' il pod scan, e il job trashapply parte entro il quarto d'ora.
    instance.post('/trash', async (req, reply) => {
        const body = req.body || {};
        const ids = (list) => (Array.isArray(list) ? list : [])
            .map((id) => utils.toInt(id, null))
            .filter((id) => id !== null);

        const media_ids = ids(body.media_ids);
        const other_ids = ids(body.other_ids);
        const folder_ids = ids(body.folder_ids);
        if (media_ids.length === 0 && other_ids.length === 0 && folder_ids.length === 0) {
            return reply.status(400).send({ error: 'serve media_ids[], other_ids[] oppure folder_ids[]' });
        }

        // Le cartelle si cestinano per prime: cosi' i media che stanno dentro
        // una cartella cestinata non generano anche una riga per file.
        const cartelle = await db.trashFolders(folder_ids);
        const files = await db.trashMedia(media_ids, other_ids);
        return { ...files, ...cartelle };
    });

    instance.get('/trash/stats', async () => {
        return await db.getTrashStats();
    });

    // ---------- job e parametri ----------

    instance.get('/jobs', async () => {
        return await db.getJobs();
    });

    instance.post('/jobs', async (req, reply) => {
        const { name, when } = req.body || {};
        if (!name) {
            return reply.status(400).send({ error: 'serve il nome del job' });
        }
        return await db.upsertPendingJob(name, when ? new Date(when) : new Date());
    });

    instance.delete('/jobs/:id', async (req) => {
        await db.deleteJob(utils.toInt(req.params.id, null));
        return { ok: true };
    });

    instance.get('/parameters', async () => {
        return await db.getParameters();
    });

    instance.post('/parameters', async (req, reply) => {
        const reason = db.invalidParameters(req.body || {});
        if (reason) {
            return reply.status(400).send({ error: reason });
        }
        return await db.saveParameters(req.body || {});
    });

    instance.get('/logs', async (req) => {
        return await db.getLogs(utils.toInt(req.query.limit, 200));
    });

    done();
}, { prefix: '/api' });

// =============== ROTTE INTERNE (bearer token) =============== //
//
// Unica regola di sicurezza dell'applicazione: se il path inizia per
// /api/internal serve il bearer token, tutto il resto e' aperto.
// Raggruppare le rotte dei cron sotto un prefisso dedicato rende la regola
// verificabile a colpo d'occhio, invece di dover controllare rotta per rotta.

fastify.register((instance, opts, done) => {

    instance.addHook('preHandler', async (req, reply) => {
        const expected = process.env.BEARER_TOKEN;
        if (!expected) {
            logger.error('BEARER_TOKEN non configurato: rotte interne disabilitate');
            return reply.status(503).send({ error: 'token non configurato' });
        }
        const header = req.headers.authorization || '';
        if (header !== `Bearer ${expected}`) {
            return reply.status(401).send({ error: 'non autorizzato' });
        }
    });

    // ---------- coda dei job ----------

    instance.post('/jobs/claim', async (req, reply) => {
        const names = (req.body || {}).names;
        if (!Array.isArray(names) || names.length === 0) {
            return reply.status(400).send({ error: 'serve la lista dei nomi di job gestiti' });
        }
        return await db.claimNextJob(names);
    });

    // Battito: dice all'API che il pod e' ancora vivo e sta lavorando su quel
    // job. Senza, dopo mezz'ora di silenzio il claim lo considera orfano.
    instance.post('/jobs/:id/heartbeat', async (req, reply) => {
        const job_id = utils.toInt(req.params.id, null);
        const alive = await db.touchJob(job_id);
        if (!alive) {
            // Il job non e' piu' 'running': o e' stato chiuso a mano, o il
            // reaper lo ha gia' recuperato. Il pod deve saperlo.
            return reply.status(409).send({ error: 'job non in esecuzione' });
        }
        return { ok: true };
    });

    instance.patch('/jobs/:id', async (req) => {
        const { status, result } = req.body || {};
        await db.updateJobStatus(utils.toInt(req.params.id, null), status, result);
        return { ok: true };
    });

    instance.post('/jobs', async (req) => {
        const { name, when } = req.body || {};
        return await db.upsertPendingJob(name, when ? new Date(when) : new Date());
    });

    instance.get('/parameters', async () => {
        return await db.getParameters();
    });

    // ---------- scansione ----------

    instance.get('/scan/roots', async () => {
        return await db.getRoots(true);
    });

    instance.post('/scan/root', async (req, reply) => {
        const { name, rel_path } = req.body || {};
        // rel_path vuoto e' legittimo: significa la radice della share.
        if (!name || rel_path === undefined || rel_path === null) {
            return reply.status(400).send({ error: 'servono name e rel_path' });
        }
        return await db.upsertRoot(name, rel_path);
    });

    instance.post('/scan/folder', async (req, reply) => {
        const { root_id, path } = req.body || {};
        if (!root_id || !path) {
            return reply.status(400).send({ error: 'servono root_id e path' });
        }
        return await db.registerFolder(root_id, path);
    });

    instance.post('/scan/media/batch', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const rows = await db.ingestMedia(items);
        return { count: rows.length, items: rows };
    });

    instance.post('/scan/other/batch', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const count = await db.ingestOthers(items);
        return { count };
    });

    // L'inizio della scansione si prende dal job, cioe' dall'orologio del
    // database: last_seen lo scrive NOW() di Postgres, e confrontarlo con
    // l'orologio del pod voleva dire che un pod avanti di qualche secondo
    // faceva marcare mancanti i file visti in quei secondi. started_at resta
    // per i pod che non mandano ancora job_id.
    instance.post('/scan/reconcile', async (req, reply) => {
        const { root_id, started_at, job_id } = req.body || {};
        const started = job_id ? await db.getJobStarted(job_id) : started_at;
        if (!root_id || !started) {
            return reply.status(400).send({ error: 'servono root_id e job_id (o started_at)' });
        }
        const outcome = await db.reconcileScan(root_id, new Date(started));
        if (outcome.refused) {
            // 409 e non 500: non e' un errore del server, e' un rifiuto deliberato.
            return reply.status(409).send(outcome);
        }
        return outcome;
    });

    // ---------- code di lavoro dei cron ----------

    instance.get('/pending/:stage', async (req, reply) => {
        const limit = utils.clamp(utils.toInt(req.query.limit, DEFAULT_PAGE), 1, MAX_PAGE);
        const after = utils.toInt(req.query.after, 0);
        try {
            return await db.getPending(req.params.stage, limit, after);
        }
        catch(err) {
            return reply.status(400).send({ error: err.message });
        }
    });

    // Esito del job dei luoghi: tag e chiusura della coda in una chiamata sola.
    instance.post('/place/batch', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const count = await db.applyPlaces(items);
        return { count };
    });

    // Un media che si e' rivelato altro -- una nota vocale in .3gp, che e' un
    // contenitore video -- esce dalla libreria ed entra fra i file non gestiti.
    instance.post('/media/not-media', async (req, reply) => {
        const ids = (req.body || {}).media_ids;
        if (!Array.isArray(ids)) {
            return reply.status(400).send({ error: 'serve media_ids[]' });
        }
        return await db.markNotMedia(ids.map((id) => utils.toInt(id, null)).filter(Boolean));
    });

    // Ricalcolo degli accoppiamenti Live Photo. Sta fra le rotte interne perche'
    // lo chiama il pod come job: e' una passata SQL, ma deve girare **dopo**
    // thumbs, che e' l'unico a conoscere la durata dei video.
    instance.post('/livephotos/pair', async () => {
        return await db.pairLivePhotos();
    });

    instance.post('/thumb/batch', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const count = await db.setThumbResults(items);
        return { count };
    });

    // ---------- duplicati ----------

    instance.post('/dedup/hashes', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const count = await db.saveHashes(items);
        return { count };
    });

    instance.post('/dedup/rebuild', async () => {
        return await db.rebuildDuplicates();
    });

    // ---------- cestino ----------

    instance.get('/trash/pending', async (req) => {
        const limit = utils.clamp(utils.toInt(req.query.limit, DEFAULT_PAGE), 1, MAX_PAGE);
        return await db.getPendingTrash(limit);
    });

    instance.get('/trash/expired', async (req) => {
        const limit = utils.clamp(utils.toInt(req.query.limit, DEFAULT_PAGE), 1, MAX_PAGE);
        return await db.getExpiredTrash(limit);
    });

    instance.post('/trash/:id/done', async (req) => {
        const { status, result } = req.body || {};
        await db.completeTrash(utils.toInt(req.params.id, null), status, result);
        return { ok: true };
    });

    instance.post('/trash/:id/purged', async (req) => {
        const { status, result } = req.body || {};
        await db.completePurge(utils.toInt(req.params.id, null), status || 'purged', result);
        return { ok: true };
    });

    done();
}, { prefix: '/api/internal' });

// =============== AVVIO =============== //

async function run() {
    const port = utils.toInt(process.env.PORT, 3000);
    fastify.listen({ port, host: '0.0.0.0' }, (err) => {
        if (err) {
            logger.error(err, 'avvio fallito');
            process.exit(1);
        }
    });
}

module.exports = { run, fastify };
