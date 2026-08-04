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
async function sendFile(reply, filePath, mimeType) {
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

        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        reply.header('ETag', `"${media_id}-${size}-${req.query.v || '0'}"`);
        return sendFile(reply, paths.thumbPath(media_id, size), 'image/jpeg');
    });

    // Originale, con supporto Range: serve alla riproduzione video e al download.
    instance.get('/media/:id/original', async (req, reply) => {
        const media_id = utils.toInt(req.params.id, null);
        const item = await db.getMediaDetail(media_id);
        if (!item) {
            return reply.status(404).send({ error: 'media non trovato' });
        }

        const filePath = paths.originalPath(item.rel_path, item.folder_path, item.file_name);
        if (!paths.isInsideRoot(filePath)) {
            return reply.status(400).send({ error: 'percorso non valido' });
        }

        // Un solo file handle per stat e stream: l'esito e' noto prima di
        // iniziare a rispondere (vedi la nota in sendFile), e non c'e' finestra
        // tra il controllo e l'apertura in cui il file possa sparire.
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
    });

    // ---------- tag ----------

    instance.get('/tags', async () => {
        return await db.getTags();
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

    instance.post('/parameters', async (req) => {
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

    instance.post('/scan/reconcile', async (req, reply) => {
        const { root_id, started_at } = req.body || {};
        if (!root_id || !started_at) {
            return reply.status(400).send({ error: 'servono root_id e started_at' });
        }
        const outcome = await db.reconcileScan(root_id, new Date(started_at));
        if (outcome.refused) {
            // 409 e non 500: non e' un errore del server, e' un rifiuto deliberato.
            return reply.status(409).send(outcome);
        }
        return outcome;
    });

    // ---------- code di lavoro dei cron ----------

    instance.get('/pending/:stage', async (req, reply) => {
        const limit = utils.clamp(utils.toInt(req.query.limit, DEFAULT_PAGE), 1, MAX_PAGE);
        try {
            return await db.getPending(req.params.stage, limit);
        }
        catch(err) {
            return reply.status(400).send({ error: err.message });
        }
    });

    instance.post('/thumb/batch', async (req, reply) => {
        const items = (req.body || {}).items;
        if (!Array.isArray(items)) {
            return reply.status(400).send({ error: 'serve items[]' });
        }
        const count = await db.setThumbResults(items);
        return { count };
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
