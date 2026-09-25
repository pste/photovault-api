// Raggruppamento dei duplicati.
//
// Sta nell'API e non nel pod dedup perche' e' pura elaborazione di dati che
// vivono nel database: il pod calcola gli hash leggendo i file, qui si decide
// chi somiglia a chi.
const logger = require('./logger');
const duplicates = require('./dbmodels/duplicates');

// Union-find: chiusura transitiva delle coppie simili.
// Se A somiglia a B e B somiglia a C, i tre finiscono nello stesso gruppo anche
// quando A e C non si somigliano abbastanza da formare una coppia.
// Venti righe leggibili al posto di una CTE ricorsiva.
function buildComponents(pairs) {
    const parent = new Map();

    function find(x) {
        if (!parent.has(x)) {
            parent.set(x, x);
        }
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x))); // compressione di percorso
            x = parent.get(x);
        }
        return x;
    }

    function union(a, b) {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) {
            parent.set(rootA, rootB);
        }
    }

    for (const pair of pairs) {
        union(pair.a_id, pair.b_id);
    }

    const components = new Map();
    for (const node of parent.keys()) {
        const root = find(node);
        if (!components.has(root)) {
            components.set(root, []);
        }
        components.get(root).push(node);
    }
    return components;
}

// I gruppi aperti toccati dalle coppie nuove entrano nell'union-find come archi
// fra i loro membri: basta collegare ogni membro al primo.
function groupEdges(groups) {
    const edges = [];
    for (const group of groups) {
        for (const media_id of group.members.slice(1)) {
            edges.push({ a_id: group.members[0], b_id: media_id });
        }
    }
    return edges;
}

// Distanza di Hamming tra due dHash espressi come stringhe di 64 bit.
// Stesso calcolo di bit_count(a # b) in PostgreSQL, qui in JS perche' serve
// filtrare un gruppo gia' caricato in memoria.
function hamming(a, b) {
    if (!a || !b || a.length !== b.length) {
        return Number.MAX_SAFE_INTEGER;
    }
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            distance++;
        }
    }
    return distance;
}

// La chiusura transitiva dell'union-find crea CATENE: A somiglia a B, B a C,
// C a D, e ci si ritrova un gruppo dove il primo e l'ultimo non si somigliano
// affatto. Misurato su un archivio reale: un gruppo da 136 elementi del tutto
// scorrelati tra loro.
//
// Qui il gruppo viene ridotto a una STELLA: si tengono solo i membri che
// somigliano al keeper entro la soglia. E' anche quello che l'utente si
// aspetta vedendo "questi sono duplicati tra loro".
function starFilter(rows, keeperId, maxDistance) {
    const keeper = rows.find((row) => row.media_id === keeperId);
    if (!keeper || !keeper.dhash) {
        return rows;
    }
    return rows.filter((row) => {
        if (row.media_id === keeperId) {
            return true;
        }
        return hamming(keeper.dhash, row.dhash) <= maxDistance;
    });
}

// Keeper proposto: piu' pixel, poi file piu' grande, poi il piu' vecchio, poi
// il percorso piu' corto. E' una proposta, non una decisione: la conferma
// l'utente dalla pagina Duplicati.
function pickKeeper(rows) {
    const sorted = [...rows].sort((a, b) => {
        const pixelsA = (a.width || 0) * (a.height || 0);
        const pixelsB = (b.width || 0) * (b.height || 0);
        if (pixelsA !== pixelsB) {
            return pixelsB - pixelsA;
        }
        const sizeA = Number(a.file_size || 0);
        const sizeB = Number(b.file_size || 0);
        if (sizeA !== sizeB) {
            return sizeB - sizeA;
        }
        const timeA = new Date(a.modified).getTime();
        const timeB = new Date(b.modified).getTime();
        if (timeA !== timeB) {
            return timeA - timeB;
        }
        return (a.full_path || '').length - (b.full_path || '').length;
    });
    return sorted[0] ? sorted[0].media_id : null;
}

async function rebuild(maxDistance) {
    let exactCount = 0;
    let similarCount = 0;

    // --- duplicati esatti: stesso sha256, nessun join necessario
    const exact = await duplicates.findExactGroups();
    for (const group of exact) {
        const rows = await duplicates.getMediaBrief(group.members);
        const keeper = pickKeeper(rows);
        const outcome = await duplicates.upsertGroup(
            'exact', group.content_hash, group.members, keeper,
            Number(group.bytes_wasted), {});
        if (!outcome.skipped) {
            exactCount++;
        }
    }

    // --- duplicati simili: coppie per distanza di Hamming, poi union-find
    const pairs = await duplicates.findSimilarPairs(maxDistance);

    // Il confronto e' incrementale, quindi le coppie nuove non vedono i gruppi
    // gia' aperti. Se C arriva nuovo e somiglia ad A, che sta nel gruppo aperto
    // {A,B}, il gruppo veniva riscritto come {A,C} e B spariva; se C somigliava
    // solo a B, B finiva in due gruppi, keeper in uno e da cestinare nell'altro.
    // Si fondono quindi i gruppi aperti toccati dalle coppie nuove: il risultato
    // e' quello che darebbe un rebuild completo.
    const pairIds = new Set();
    for (const pair of pairs) {
        pairIds.add(pair.a_id);
        pairIds.add(pair.b_id);
    }
    const touched = await duplicates.getOpenSimilarGroupsOf([...pairIds]);
    const components = buildComponents(pairs.concat(groupEdges(touched)));

    let trimmed = 0;
    let absorbed = 0;
    for (const members of components.values()) {
        if (members.length < 2) {
            continue;
        }
        const allRows = await duplicates.getMediaBrief(members);
        const keeper = pickKeeper(allRows);

        // Riduzione da catena a stella: senza, una lunga catena di somiglianze
        // a due a due produce gruppi enormi e privi di senso.
        const rows = starFilter(allRows, keeper, maxDistance);
        if (rows.length < allRows.length) {
            trimmed += allRows.length - rows.length;
        }
        if (rows.length < 2) {
            continue;
        }

        // Lo spazio recuperabile e' tutto tranne il file che si tiene.
        const total = rows.reduce((sum, row) => sum + Number(row.file_size || 0), 0);
        const keeperRow = rows.find((row) => row.media_id === keeper);
        const wasted = total - Number(keeperRow ? keeperRow.file_size : 0);

        // La distanza mostrata accanto alla miniatura e' quella dal keeper: e'
        // il criterio con cui la stella ha tenuto il membro.
        const distances = {};
        for (const row of rows) {
            distances[row.media_id] = hamming(keeperRow.dhash, row.dhash);
        }

        const kept = rows.map((row) => row.media_id);
        const groupKey = Math.min(...kept);
        const outcome = await duplicates.upsertGroup(
            'similar', groupKey, kept, keeper, wasted, distances);
        if (outcome.skipped) {
            continue;
        }
        similarCount++;

        // I gruppi aperti fusi in questo, se avevano un'altra chiave, sono
        // ora un doppione: vanno tolti.
        const merged = touched
            .filter((group) => group.group_key !== String(groupKey))
            .filter((group) => group.members.some((id) => members.includes(id)))
            .map((group) => group.dup_group_id);
        absorbed += await duplicates.deleteOpenGroups(merged);
    }

    const checked = await duplicates.markDedupChecked();
    const dropped = await duplicates.dropStaleGroups();

    logger.info({ exactCount, similarCount, trimmed, absorbed, checked, dropped }, 'rebuild duplicati concluso');
    return {
        gruppi_esatti: exactCount,
        gruppi_simili: similarCount,
        confrontati: checked,
        gruppi_rimossi: dropped + absorbed,
        membri_scartati: trimmed,
    };
}

module.exports = { rebuild, buildComponents, pickKeeper };
