const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');
const { NOT_TRASHED_MEDIA } = require('./sqlparts');

// Colonne scritte dallo scan, nell'ordine usato dall'INSERT multi-riga.
const SCAN_COLUMNS = [
    'folder_id', 'file_name', 'media_kind', 'ext', 'file_size', 'modified',
    'width', 'height', 'duration_s', 'orientation', 'capture_ts',
    'camera_make', 'camera_model', 'gps_lat', 'gps_lon',
];

// Un file e' "cambiato" se cambia la dimensione oppure l'mtime, con un secondo di
// tolleranza: SMB e i filesystem locali non concordano sui sottosecondi, e senza
// tolleranza ogni scansione riterrebbe modificato l'intero archivio.
const IS_CHANGED = `(
    media.file_size IS DISTINCT FROM EXCLUDED.file_size
    OR abs(EXTRACT(EPOCH FROM media.modified - EXCLUDED.modified)) > 1
)`;

// Campi restituiti alla UI per la griglia. Si tiene fuori tutto il resto:
// una cartella da 200 foto non deve trascinarsi dietro EXIF che nessuno mostra.
const GRID_FIELDS = `
    m.media_id, m.folder_id, m.file_name, m.media_kind, m.width, m.height,
    m.duration_s, m.capture_ts, m.thumb_status,
    EXTRACT(EPOCH FROM m.updated)::bigint AS v`;

async function getMedia(media_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT m.*, f."path" AS folder_path, f.root_id, r.rel_path
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            JOIN roots r ON r.root_id = f.root_id
            WHERE m.media_id = $1`;
        logger.trace({ media_id }, 'DB: getMedia');
        const res = await client.query(stm, [media_id]);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB getMedia', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getMediaInFolder(folder_id, limit, offset) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT ${GRID_FIELDS}
            FROM media m
            WHERE m.folder_id = $1 AND m.missing_since IS NULL
              AND ${NOT_TRASHED_MEDIA('m')}
            ORDER BY m.capture_ts DESC NULLS LAST, m.media_id
            LIMIT $2 OFFSET $3`;
        logger.trace({ folder_id, limit, offset }, 'DB: getMediaInFolder');
        const res = await client.query(stm, [folder_id, limit, offset]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getMediaInFolder', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function countMediaInFolder(folder_id) {
    const client = await pool.connect();
    try {
        const stm = `SELECT count(*)::int AS n FROM media m
                     WHERE m.folder_id = $1 AND m.missing_since IS NULL
                       AND ${NOT_TRASHED_MEDIA('m')}`;
        const res = await client.query(stm, [folder_id]);
        return res.rows[0].n;
    }
    catch(err) {
        dblog.createLog('ERROR DB countMediaInFolder', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Ricerca. Ogni filtro e' opzionale e si spegne da solo quando il parametro e' NULL,
// cosi' resta una query sola invece di una concatenazione di stringhe.
// A queste dimensioni la ILIKE e' una scansione sequenziale da poche decine di ms:
// pg_trgm si valutera' oltre il mezzo milione di righe.
function buildSearch(filters, forCount) {
    const pars = [
        filters.q || null,
        filters.kind || null,
        filters.from || null,
        filters.to || null,
        filters.tag || null,
        filters.folderPath || null,
    ];
    const where = `
        WHERE m.missing_since IS NULL
          AND ${NOT_TRASHED_MEDIA('m')}
          AND ($1::varchar IS NULL OR lower(m.file_name) LIKE '%' || lower($1) || '%'
                                   OR lower(f."path") LIKE '%' || lower($1) || '%')
          AND ($2::varchar IS NULL OR m.media_kind = $2)
          AND ($3::timestamptz IS NULL OR m.capture_ts >= $3)
          AND ($4::timestamptz IS NULL OR m.capture_ts <= $4)
          AND ($5::varchar IS NULL OR EXISTS (
                SELECT 1 FROM media_tags mt
                JOIN tags t ON t.tag_id = mt.tag_id
                WHERE mt.media_id = m.media_id AND t."name" = $5))
          AND ($6::varchar IS NULL OR f."path" LIKE $6 || '%')`;

    const from = `
        FROM media m
        JOIN folders f ON f.folder_id = m.folder_id`;

    if (forCount) {
        return { stm: `SELECT count(*)::int AS n ${from} ${where}`, pars };
    }
    return {
        stm: `SELECT ${GRID_FIELDS}, f."path" AS folder_path ${from} ${where}
              ORDER BY m.capture_ts DESC NULLS LAST, m.media_id
              LIMIT $7 OFFSET $8`,
        pars,
    };
}

async function search(filters, limit, offset) {
    const client = await pool.connect();
    try {
        const q = buildSearch(filters, false);
        logger.trace(filters, 'DB: search');
        const res = await client.query(q.stm, [...q.pars, limit, offset]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB search', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function countSearch(filters) {
    const client = await pool.connect();
    try {
        const q = buildSearch(filters, true);
        const res = await client.query(q.stm, q.pars);
        return res.rows[0].n;
    }
    catch(err) {
        dblog.createLog('ERROR DB countSearch', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Upsert di un blocco di file. Lo scan manda TUTTI i file che incontra, non solo
// quelli cambiati: e' l'ON CONFLICT qui sotto a distinguere i due casi, cosi' lo
// scan non deve interrogare il DB per fare change detection.
//
// - sempre: last_seen = NOW() (e' cosi' che il reconcile riconosce i file spariti)
// - solo se il file e' cambiato: si aggiornano i metadati, si sposta updated
//   (token di cache delle thumbnail) e si azzera lo stato della pipeline.
//
// Un INSERT multi-riga invece di N query: un solo giro di rete per blocco.
// L'idempotenza e' gratis grazie alla chiave naturale (folder_id, file_name),
// quindi rigiocare un blocco dopo un crash non ha effetti collaterali.
async function upsertMediaBatch(items) {
    if (!items || items.length === 0) {
        return [];
    }
    const client = await pool.connect();
    try {
        const values = [];
        const pars = [];
        items.forEach((item, row) => {
            const base = row * SCAN_COLUMNS.length;
            const placeholders = SCAN_COLUMNS.map((_, i) => `$${base + i + 1}`);
            values.push(`(${placeholders.join(', ')})`);
            pars.push(
                item.folder_id, item.file_name, item.media_kind, item.ext,
                item.file_size, item.modified,
                item.width || null, item.height || null, item.duration_s || null,
                item.orientation || null, item.capture_ts || null,
                item.camera_make || null, item.camera_model || null,
                item.gps_lat || null, item.gps_lon || null,
            );
        });

        const stm = `
            INSERT INTO media (${SCAN_COLUMNS.join(', ')})
            VALUES ${values.join(', ')}
            ON CONFLICT (folder_id, file_name) DO UPDATE SET
                last_seen     = NOW(),
                missing_since = NULL,
                file_size     = EXCLUDED.file_size,
                modified      = EXCLUDED.modified,
                media_kind    = EXCLUDED.media_kind,
                ext           = EXCLUDED.ext,
                width         = COALESCE(EXCLUDED.width, media.width),
                height        = COALESCE(EXCLUDED.height, media.height),
                duration_s    = COALESCE(EXCLUDED.duration_s, media.duration_s),
                orientation   = COALESCE(EXCLUDED.orientation, media.orientation),
                -- capture_ts NON segue il COALESCE delle altre: lo scan la manda
                -- sempre valorizzata con l'mtime, quindi un COALESCE su
                -- EXCLUDED sostituirebbe la data EXIF gia' in archivio con la
                -- data di modifica del file -- e, non essendo il file cambiato,
                -- thumb_status resterebbe 'done' e nessuno rileggerebbe piu'
                -- l'EXIF. Su un file cambiato invece il ripiego e' corretto: la
                -- pipeline riparte da 'pending' e thumbs raffinera' il valore.
                capture_ts    = CASE WHEN ${IS_CHANGED}
                                     THEN EXCLUDED.capture_ts
                                     ELSE COALESCE(media.capture_ts, EXCLUDED.capture_ts) END,
                camera_make   = COALESCE(EXCLUDED.camera_make, media.camera_make),
                camera_model  = COALESCE(EXCLUDED.camera_model, media.camera_model),
                gps_lat       = COALESCE(EXCLUDED.gps_lat, media.gps_lat),
                gps_lon       = COALESCE(EXCLUDED.gps_lon, media.gps_lon),
                updated       = CASE WHEN ${IS_CHANGED} THEN NOW() ELSE media.updated END,
                thumb_status  = CASE WHEN ${IS_CHANGED} THEN 'pending' ELSE media.thumb_status END,
                label_status  = CASE WHEN ${IS_CHANGED} THEN 'pending' ELSE media.label_status END,
                content_hash  = CASE WHEN ${IS_CHANGED} THEN NULL ELSE media.content_hash END,
                dhash         = CASE WHEN ${IS_CHANGED} THEN NULL ELSE media.dhash END,
                dedup_checked = CASE WHEN ${IS_CHANGED} THEN NULL ELSE media.dedup_checked END
            RETURNING media_id, folder_id, file_name, thumb_status`;

        logger.trace({ rows: items.length }, 'DB: upsertMediaBatch');
        const res = await client.query(stm, pars);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertMediaBatch', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Quanti media di questa root sono stati visti dall'inizio della scansione.
async function countSeenSince(root_id, since) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT count(*)::int AS n
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            WHERE f.root_id = $1 AND m.last_seen >= $2`;
        logger.trace({ root_id, since }, 'DB: countSeenSince');
        const res = await client.query(stm, [root_id, since]);
        return res.rows[0].n;
    }
    catch(err) {
        dblog.createLog('ERROR DB countSeenSince', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Marca come mancanti i media non visti nella scansione appena conclusa.
// Non e' mai una DELETE: la rimozione definitiva resta un'azione esplicita
// dell'utente, perche' una share smontata e una cartella svuotata sono
// indistinguibili a livello di syscall.
async function markMissing(root_id, since) {
    const client = await pool.connect();
    try {
        const stm = `
            UPDATE media m SET missing_since = NOW()
            FROM folders f
            WHERE f.folder_id = m.folder_id
              AND f.root_id = $1
              AND m.missing_since IS NULL
              AND m.last_seen < $2`;
        logger.trace({ root_id, since }, 'DB: markMissing');
        const res = await client.query(stm, [root_id, since]);
        return res.rowCount;
    }
    catch(err) {
        dblog.createLog('ERROR DB markMissing', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Coda di lavoro dei cron. Le colonne di stato SONO la coda: nessuna tabella
// di code separata, nessun checkpoint di ripartenza.
async function getPending(stage, limit) {
    const conditions = {
        thumb: "m.thumb_status = 'pending'",
        // I luoghi non dipendono dalle thumbnail: si ricavano dal GPS EXIF o
        // dal nome della cartella, quindi la loro coda e' solo place_status.
        place: "m.place_status = 'pending'",
        label: "m.label_status = 'pending' AND m.thumb_status = 'done'",
        hash:  'm.content_hash IS NULL',
        dhash: "m.dhash IS NULL AND m.thumb_status = 'done' AND m.media_kind <> 'video'",
    };
    const cond = conditions[stage];
    if (!cond) {
        throw new Error(`getPending: stage sconosciuto "${stage}"`);
    }
    const client = await pool.connect();
    try {
        const stm = `
            -- m.orientation non serve piu' al pod nuovo, che legge l'EXIF da
            -- se'. Resta perche' il pod VECCHIO ci raddrizza le immagini: nella
            -- finestra fra il rilascio dell'API e quello dello scan, senza
            -- questa colonna le foto verticali diventerebbero thumbnail storte,
            -- marcate 'done' e mai piu' rigenerate.
            SELECT m.media_id, m.file_name, m.media_kind, m.ext, m.file_size,
                   m.orientation, m.gps_lat, m.gps_lon,
                   f."path" AS folder_path, r.rel_path
            FROM media m
            JOIN folders f ON f.folder_id = m.folder_id
            JOIN roots r ON r.root_id = f.root_id
            WHERE m.missing_since IS NULL AND ${cond}
            ORDER BY m.media_id
            LIMIT $1`;
        logger.trace({ stage, limit }, 'DB: getPending');
        const res = await client.query(stm, [limit]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getPending', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Esito della generazione thumbnail, e con esso tutti i metadati del file.
//
// Viaggiano insieme perche' escono dallo stesso lavoro: il job apre il file una
// volta sola e ne ricava sia l'anteprima sia l'EXIF. Lo scan non li manda piu',
// perche' camminare la share e aprire 146.000 file sono due mestieri diversi.
//
// Ogni campo e' in COALESCE: un valore assente non cancella quello che c'e'.
// Vale anche per capture_ts, che lo scan ha gia' valorizzato con l'mtime -- se
// il file non ha una data EXIF, quel ripiego resta.
async function setThumbResults(items) {
    if (!items || items.length === 0) {
        return 0;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stm = `
            UPDATE media SET
                thumb_status = $2,
                width        = COALESCE($3, width),
                height       = COALESCE($4, height),
                duration_s   = COALESCE($5, duration_s),
                orientation  = COALESCE($6, orientation),
                capture_ts   = COALESCE($7, capture_ts),
                camera_make  = COALESCE($8, camera_make),
                camera_model = COALESCE($9, camera_model),
                gps_lat      = COALESCE($10, gps_lat),
                gps_lon      = COALESCE($11, gps_lon),
                -- Le coordinate arrivano qui, non dallo scan: se questa foto
                -- era gia' passata dai luoghi lo aveva fatto senza GPS, quindi
                -- va rimessa in coda. Senza, una foto etichettata prima della
                -- sua thumbnail non avrebbe mai il suo toponimo.
                place_status = CASE WHEN $10 IS NOT NULL THEN 'pending' ELSE place_status END,
                updated = NOW()
            WHERE media_id = $1`;
        for (const item of items) {
            // ?? e non ||: la longitudine 0 e' un valore legittimo (Greenwich),
            // e con || sparirebbe insieme ai campi davvero assenti.
            await client.query(stm, [
                item.media_id, item.thumb_status,
                item.width ?? null, item.height ?? null,
                item.duration_s ?? null, item.orientation ?? null,
                item.capture_ts ?? null,
                item.camera_make ?? null, item.camera_model ?? null,
                item.gps_lat ?? null, item.gps_lon ?? null,
            ]);
        }
        await client.query('COMMIT');
        logger.trace({ rows: items.length }, 'DB: setThumbResults');
        return items.length;
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB setThumbResults', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Esito del job dei luoghi. I tag li applica db.applyTags: qui si chiude solo
// la coda, perche' un media senza GPS e senza toponimo nel percorso e' comunque
// stato esaminato e non deve tornare in fila a ogni giro.
async function setPlaceResults(items) {
    if (!items || items.length === 0) {
        return 0;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const item of items) {
            await client.query('UPDATE media SET place_status = $2 WHERE media_id = $1',
                               [item.media_id, item.place_status || 'done']);
        }
        await client.query('COMMIT');
        logger.trace({ rows: items.length }, 'DB: setPlaceResults');
        return items.length;
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB setPlaceResults', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getStats() {
    const client = await pool.connect();
    try {
        // Per ogni fase servono tutti e tre i numeri, non solo "quanti mancano":
        // una barra che si ferma al 98% e non arriva mai a 100 e' incomprensibile
        // finche' non si vede che il resto e' in errore, non in coda.
        const stm = `
            SELECT
                count(*)::int AS media_total,
                count(*) FILTER (WHERE media_kind = 'video')::int AS videos,
                count(*) FILTER (WHERE media_kind <> 'video')::int AS images,

                -- Fuori dal WHERE qui sotto, altrimenti sarebbe sempre zero.
                (SELECT count(*) FROM media WHERE missing_since IS NOT NULL)::int AS missing,

                count(*) FILTER (WHERE thumb_status = 'pending')::int AS thumb_pending,
                count(*) FILTER (WHERE thumb_status = 'done')::int    AS thumb_done,
                count(*) FILTER (WHERE thumb_status NOT IN ('pending', 'done'))::int AS thumb_error,

                count(*) FILTER (WHERE place_status = 'pending')::int AS place_pending,
                count(*) FILTER (WHERE place_status = 'done')::int    AS place_done,

                count(*) FILTER (WHERE label_status = 'pending')::int AS label_pending,
                count(*) FILTER (WHERE label_status = 'done')::int    AS label_done,

                count(*) FILTER (WHERE content_hash IS NULL)::int     AS hash_pending,
                count(*) FILTER (WHERE content_hash IS NOT NULL)::int AS hash_done,

                -- Il dHash riguarda le sole immagini, e solo quelle con
                -- l'anteprima gia' fatta: e' dalla thumbnail che si calcola.
                count(*) FILTER (WHERE media_kind <> 'video' AND dhash IS NOT NULL)::int AS dhash_done,
                count(*) FILTER (WHERE media_kind <> 'video')::int AS dhash_total,

                COALESCE(sum(file_size), 0)::bigint AS bytes_total
            FROM media
            -- I file spariti dalla share restano in archivio ma non sono in
            -- nessuna coda: contarli renderebbe le barre incompletabili.
            WHERE missing_since IS NULL`;
        const res = await client.query(stm);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB getStats', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    getMedia, getMediaInFolder, countMediaInFolder,
    search, countSearch,
    upsertMediaBatch, countSeenSince, markMissing,
    getPending, setThumbResults, setPlaceResults, getStats,
};
