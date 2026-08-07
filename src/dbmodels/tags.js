const logger = require('../logger');
const dblog = require('./logs');
const pool = require('./dbpool');

// Tag con il conteggio d'uso, per la barra dei filtri.
async function getTags() {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.tag_id, t."name", t.display_name, t.kind, count(mt.media_id)::int AS usage
            FROM tags t
            LEFT JOIN media_tags mt ON mt.tag_id = t.tag_id
            GROUP BY t.tag_id
            ORDER BY t.kind, t.display_name`;
        logger.trace('DB: getTags');
        const res = await client.query(stm);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function getMediaTags(media_id) {
    const client = await pool.connect();
    try {
        const stm = `
            SELECT t.tag_id, t."name", t.display_name, t.kind, mt.score, mt."source"
            FROM media_tags mt
            JOIN tags t ON t.tag_id = mt.tag_id
            WHERE mt.media_id = $1
            ORDER BY mt."source", mt.score DESC NULLS LAST, t.display_name`;
        logger.trace({ media_id }, 'DB: getMediaTags');
        const res = await client.query(stm, [media_id]);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getMediaTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function upsertTag(name, display_name, kind) {
    const client = await pool.connect();
    try {
        // L'aggiornamento e' volutamente un non-aggiornamento: chi arriva per
        // primo fissa il nome visualizzato, e i giri successivi non lo toccano.
        // Prima qui c'era EXCLUDED.display_name, che avrebbe cancellato ogni
        // rinomina fatta a mano al primo passaggio del job -- in silenzio.
        // Non e' un DO NOTHING perche' quello non restituisce la riga esistente,
        // e chi chiama ha bisogno del tag_id.
        const stm = `
            INSERT INTO tags ("name", display_name, kind)
            VALUES ($1, $2, $3)
            ON CONFLICT ("name") DO UPDATE SET display_name = tags.display_name
            RETURNING *`;
        logger.trace({ name, kind }, 'DB: upsertTag');
        const res = await client.query(stm, [name, display_name, kind]);
        return res.rows[0];
    }
    catch(err) {
        dblog.createLog('ERROR DB upsertTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function addMediaTag(media_id, tag_id, score, source) {
    const client = await pool.connect();
    try {
        // Il SELECT al posto di VALUES e' il punto in cui il blocco ha effetto:
        // se il tag e' bloccato non esce nessuna riga e l'INSERT non fa niente.
        // Sta qui, e non in chi chiama, perche' questa e' l'unica funzione da
        // cui passa ogni assegnazione -- job dei luoghi, CLIP e mano dell'utente.
        const stm = `
            INSERT INTO media_tags (media_id, tag_id, score, "source")
            SELECT $1, t.tag_id, $3, $4 FROM tags t
            WHERE t.tag_id = $2 AND NOT t.blocked
            ON CONFLICT (media_id, tag_id)
            DO UPDATE SET score = EXCLUDED.score, "source" = EXCLUDED."source"`;
        logger.trace({ media_id, tag_id, source }, 'DB: addMediaTag');
        await client.query(stm, [media_id, tag_id, score || null, source]);
    }
    catch(err) {
        dblog.createLog('ERROR DB addMediaTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

async function removeMediaTag(media_id, tag_id) {
    const client = await pool.connect();
    try {
        const stm = 'DELETE FROM media_tags WHERE media_id = $1 AND tag_id = $2';
        logger.trace({ media_id, tag_id }, 'DB: removeMediaTag');
        await client.query(stm, [media_id, tag_id]);
    }
    catch(err) {
        dblog.createLog('ERROR DB removeMediaTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// ---------- gestione dei tag ----------
//
// Nota che vale per tutto quello che segue: **la riga di un tag non si cancella
// mai**. Il nome e' unico e i job cercano per nome, quindi una riga cancellata
// verrebbe ricreata identica al primo media rielaborato. Eliminare un tag
// significa quindi togliere le sue assegnazioni e alzare `blocked`: la riga
// resta come lapide, ed e' proprio quella lapide a impedire il ritorno.

// Elenco per la pagina di gestione: conteggio e sorgenti accanto a ogni tag.
//
// Il conteggio non e' un abbellimento, e' cio' che smaschera i falsi positivi:
// "Medea" con 3.684 foto si riconosce dal numero, non dal nome.
async function listTags({ kind, q, blocked } = {}) {
    const client = await pool.connect();
    try {
        const pars = [];
        const where = [];
        if (kind) {
            pars.push(kind);
            where.push(`t.kind = $${pars.length}`);
        }
        if (q) {
            pars.push(`%${q}%`);
            where.push(`t.display_name ILIKE $${pars.length}`);
        }
        if (blocked !== undefined && blocked !== null) {
            pars.push(blocked);
            where.push(`t.blocked = $${pars.length}`);
        }
        const stm = `
            SELECT t.tag_id, t."name", t.display_name, t.kind, t.blocked,
                   count(mt.media_id)::int AS usage,
                   array_remove(array_agg(DISTINCT mt."source"), NULL) AS sources
            FROM tags t
            LEFT JOIN media_tags mt ON mt.tag_id = t.tag_id
            ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
            GROUP BY t.tag_id
            ORDER BY count(mt.media_id) DESC, t.display_name`;
        logger.trace({ kind, q, blocked }, 'DB: listTags');
        const res = await client.query(stm, pars);
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB listTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Le categorie esistenti, per popolare i filtri senza inventarsi un elenco fisso.
async function getKinds() {
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT kind, count(*)::int AS tags FROM tags GROUP BY kind ORDER BY kind');
        return res.rows;
    }
    catch(err) {
        dblog.createLog('ERROR DB getKinds', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Rinomina, cambio di categoria e blocco: tre campi facoltativi, un solo UPDATE.
//
// Il cambio di categoria e' il caso di "Martin", che il gazetteer ha preso per
// una citta' slovacca ed e' un nome di persona: la correzione giusta non e'
// cancellarlo ma spostarlo. Da solo pero' non basta a fermare il job -- il nome
// resta lo stesso e il job cerca per nome -- quindi in UI il cambio di categoria
// va accompagnato dal blocco.
async function updateTag(tag_id, { display_name, kind, blocked }) {
    const client = await pool.connect();
    try {
        const sets = [];
        const pars = [tag_id];
        for (const [column, value] of Object.entries({ display_name, kind, blocked })) {
            if (value !== undefined && value !== null) {
                pars.push(value);
                sets.push(`${column} = $${pars.length}`);
            }
        }
        if (sets.length === 0) {
            return null;
        }
        const stm = `UPDATE tags SET ${sets.join(', ')} WHERE tag_id = $1 RETURNING *`;
        logger.info({ tag_id, display_name, kind, blocked }, 'DB: updateTag');
        const res = await client.query(stm, pars);
        return res.rows[0] || null;
    }
    catch(err) {
        dblog.createLog('ERROR DB updateTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Fonde due tag: le assegnazioni passano al secondo e il primo resta bloccato.
//
// "Roma" e "Rome" sono la stessa citta' con due nomi, e il gazetteer li crea
// entrambi. Dopo la fusione il tag di partenza non si cancella ma si blocca,
// altrimenti il giro dopo il gazetteer lo ricrea e la fusione si disfa.
async function mergeTags(fromId, intoId) {
    if (fromId === intoId) {
        throw new Error('mergeTags: un tag non si fonde con se stesso');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Le foto che hanno gia' il tag di destinazione non si spostano: la
        // chiave primaria e' (media_id, tag_id) e l'UPDATE fallirebbe.
        const moved = await client.query(`
            UPDATE media_tags mt SET tag_id = $2
            WHERE mt.tag_id = $1
              AND NOT EXISTS (
                  SELECT 1 FROM media_tags x
                  WHERE x.media_id = mt.media_id AND x.tag_id = $2
              )`, [fromId, intoId]);

        // Quelle rimaste sono i doppioni: la foto aveva entrambi i tag.
        await client.query('DELETE FROM media_tags WHERE tag_id = $1', [fromId]);
        await client.query('UPDATE tags SET blocked = true WHERE tag_id = $1', [fromId]);

        await client.query('COMMIT');
        logger.info({ fromId, intoId, moved: moved.rowCount }, 'DB: mergeTags');
        return { moved: moved.rowCount };
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB mergeTags', err);
        throw err;
    }
    finally {
        client.release();
    }
}

// Toglie tutte le assegnazioni e blocca il tag. Vedi la nota in cima: la riga
// resta, ed e' la riga a impedire che il tag torni.
async function clearTag(tag_id) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const removed = await client.query('DELETE FROM media_tags WHERE tag_id = $1', [tag_id]);
        await client.query('UPDATE tags SET blocked = true WHERE tag_id = $1', [tag_id]);
        await client.query('COMMIT');
        logger.info({ tag_id, removed: removed.rowCount }, 'DB: clearTag');
        return { removed: removed.rowCount };
    }
    catch(err) {
        await client.query('ROLLBACK');
        dblog.createLog('ERROR DB clearTag', err);
        throw err;
    }
    finally {
        client.release();
    }
}

module.exports = {
    getTags, getMediaTags, upsertTag, addMediaTag, removeMediaTag,
    listTags, getKinds, updateTag, mergeTags, clearTag,
};
