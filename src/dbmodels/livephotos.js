const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');
const { NOT_TRASHED_MEDIA } = require('./sqlparts');

// Un iPhone che scatta una Live Photo lascia sulla share due file con lo stesso
// nome: IMG_1234.JPG e IMG_1234.MOV. In libreria diventano due riquadri, e nelle
// cartelle di un telefono ogni scatto compare due volte.
//
// Le due condizioni sono state scelte misurando le 527 coppie dell'archivio
// vero, e servono **entrambe**:
//
// - la durata sotto la soglia esclude due filmini di una Olympus, che numera
//   foto e video con la stessa sequenza: P4142172.JPG e P4142172.MOV hanno lo
//   stesso nome senza avere niente a che fare l'uno con l'altro. Duravano 10
//   secondi contro i 2,47 di media delle Live Photo vere;
// - l'accoppiamento con una foto esclude i 292 video corti che stanno da soli:
//   di .MOV sotto i 4 secondi ce ne sono 817, ma solo 525 hanno una foto gemella.
//
// Con una sola delle due si sbaglierebbe in un verso o nell'altro.
const MAX_DURATION_S = 4;

// Estensioni che possono essere la foto di una Live Photo. HEIC c'e' anche se
// oggi l'archivio non ne ha nessuna: e' il formato degli iPhone recenti, e
// scoprirlo fra due anni con la stessa indagine sarebbe fatica sprecata.
const STILL_EXTS = ['jpg', 'jpeg', 'heic'];

// La coppia: stesso nome senza estensione, stessa cartella.
//
// split_part sul punto e non una regex: i nomi delle fotocamere non hanno punti
// interni, e su 338.000 righe la differenza si sente.
const PAIR_CONDITION = `
    still.folder_id = video.folder_id
    AND lower(split_part(still.file_name, '.', 1)) = lower(split_part(video.file_name, '.', 1))
    AND still.ext = ANY($1)
    AND still.missing_since IS NULL`;

// Ricalcola tutti gli accoppiamenti. Idempotente: si puo' rilanciare quando si
// vuole, ed e' quello che fa il job "livephoto" dopo ogni giro di thumbs --
// prima non si potrebbe, perche' la durata la scrive thumbs leggendo il file.
//
// Azzera prima di riscrivere: una foto cestinata, o un video che ha cambiato
// durata, devono poter sciogliere una coppia. Senza l'azzeramento un
// accoppiamento sbagliato resterebbe per sempre.
async function pair() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE media SET live_photo_of = NULL WHERE live_photo_of IS NOT NULL');

        const res = await client.query(`
            UPDATE media video
            SET live_photo_of = still.media_id
            FROM media still
            WHERE video.media_kind = 'video'
              AND video.missing_since IS NULL
              AND video.duration_s IS NOT NULL
              AND video.duration_s <= $2
              AND ${PAIR_CONDITION}`, [STILL_EXTS, MAX_DURATION_S]);

        await client.query('COMMIT');
        logger.info({ coppie: res.rowCount }, 'DB: livephotos.pair');
        return { coppie: res.rowCount };
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB livephotos.pair', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Le coppie, per la pagina che permette di cestinare i video tenendo le foto.
// Si restituiscono i due media_id insieme: l'azione ha bisogno di quello del
// video, l'anteprima di quello della foto.
async function list(limit, offset) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT video.media_id AS video_id, video.file_name AS video_name,
                   video.duration_s, video.file_size AS video_size,
                   still.media_id AS still_id, still.file_name AS still_name,
                   still.thumb_status, still.updated,
                   f."path" AS folder_path
            FROM media video
            JOIN media still ON still.media_id = video.live_photo_of
            JOIN folders f ON f.folder_id = video.folder_id
            WHERE video.live_photo_of IS NOT NULL
              AND video.missing_since IS NULL
              AND ${NOT_TRASHED_MEDIA('video')}
            ORDER BY f."path", video.file_name
            LIMIT $1 OFFSET $2`;
        logger.trace({ limit, offset }, 'DB: livephotos.list');
        const res = await client.query(stm, [limit, offset]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB livephotos.list', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function stats() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT count(*)::int AS coppie,
                   COALESCE(sum(video.file_size), 0)::bigint AS bytes_video
            FROM media video
            WHERE video.live_photo_of IS NOT NULL
              AND video.missing_since IS NULL
              AND ${NOT_TRASHED_MEDIA('video')}`);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB livephotos.stats', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Gli id dei video da cestinare, per l'azione "cestina i video e tieni le foto".
// Li sceglie il database e non la UI: cosi' l'azione vale su tutte le coppie e
// non solo su quelle della pagina aperta.
async function videoIds() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT video.media_id
            FROM media video
            WHERE video.live_photo_of IS NOT NULL
              AND video.missing_since IS NULL
              AND ${NOT_TRASHED_MEDIA('video')}`);
        return res.rows.map((r) => r.media_id);
    }
    catch(err) {
        dblog.createLog('ERROR DB livephotos.videoIds', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = { pair, list, stats, videoIds, MAX_DURATION_S };
