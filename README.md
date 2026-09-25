# photovault-api

API REST di photovault: Fastify 5 + PostgreSQL.

**È l'unico componente che parla col database.** UI e cron passano tutti da qui, così la SQL
vive in un posto solo e non c'è schema duplicato tra Node, Go e Python.

## Requisiti

- Node.js 24
- PostgreSQL con le migration di `photovault-db` applicate
- La share dei media montata in **sola lettura** (per servire thumbnail e originali)

## Setup

```bash
npm install
cp .env.dist .env
npm run dev     # nodemon, ricarica a ogni salvataggio
```

In produzione: `npm run prod`.

## Variabili d'ambiente

```
PORT=3000
LOG_LEVEL=trace
DISABLE_REQUEST_LOGGING=true

MEDIA_ROOT=/data/photos        # mount della share, in sola lettura
BEARER_TOKEN=                  # protegge le rotte /api/internal/*
SESSION_SECRET=                # firma il cookie di sessione, almeno 32 caratteri
SESSION_TIMEOUTSECS=7776000    # durata del cookie, 90 giorni

PGHOST=localhost
PGPORT=5432
PGDATABASE=photovault
PGUSER=photovault
PGPASSWORD=

UV_THREADPOOL_SIZE=16          # vedi nota sotto
```

`UV_THREADPOOL_SIZE=16` non è cosmetico: il pool libuv di default ha 4 thread e ogni lettura
su CIFS ne occupa uno per millisecondi. Con 4 thread una griglia da 200 thumbnail si
serializza in uno stallo visibile, e blocca anche tutte le altre chiamate `fs`.

## Struttura

```
app.js                 # entrypoint
src/server.js          # registrazione plugin e rotte
src/db.js              # facade: l'unica cosa che server.js importa
src/dbmodels/          # una per tabella, SQL grezza
  dbpool.js            # pool pg condiviso
src/passwords.js       # hash scrypt delle password
src/sessionStore.js    # store di @fastify/session sulla tabella sessions
src/loginLimiter.js    # limite ai tentativi di login falliti
src/cli.js             # node app.js user add|passwd|del|list
src/logger.js
src/utils.js
```

Ogni funzione dei dbmodels segue lo stesso schema: `pool.connect()`, `try` con la query,
`catch` che logga e rilancia, `finally` con `client.release()`.

## Autenticazione

Due regole, una per chi usa l'app e una per i cron:

- **l'utente fa login.** Tutte le rotte sotto `/api` richiedono una sessione, tranne
  `/api/health` (le probe di Kubernetes), `/api/login` e `/api/logout`;
- **i cron usano il bearer token.** Le rotte `/api/internal/*` vogliono
  `Authorization: Bearer $BEARER_TOKEN`, e la sessione non conta. Sono raggruppate in un
  unico `fastify.register` con `prefix` e un solo `preHandler`, così la regola è verificabile
  a colpo d'occhio.

L'app resta in LAN: il login c'è per alzare la sicurezza e per sapere chi fa cosa. Tutti gli
utenti vedono la stessa libreria, senza ruoli.

- **Password**: hash `scrypt` della libreria standard, con salt e confronto a tempo costante;
  mai in chiaro. Un nome inesistente costa lo stesso tempo di una password sbagliata, e la
  risposta è la stessa.
- **Sessioni**: `@fastify/session` con lo store su Postgres (tabella `sessions`), così un
  riavvio dell'API non slogga nessuno. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` quando la
  richiesta arriva in HTTPS. Dura 90 giorni e si rinnova quando si usa l'app, ma al massimo
  una volta al giorno: una griglia chiede 200 thumbnail, e rinnovare a ogni richiesta sarebbero
  200 scritture per pagina.
- **Tentativi falliti**: 10 per nome utente e 20 per IP ogni 15 minuti, poi 429.

Gli utenti si gestiscono da riga di comando, mai da una rotta web:

```bash
kubectl -n photovault exec -it deploy/api -- node app.js user add <nome>
kubectl -n photovault exec -it deploy/api -- node app.js user passwd <nome>
kubectl -n photovault exec -it deploy/api -- node app.js user del <nome>
kubectl -n photovault exec -it deploy/api -- node app.js user list
```

La password si chiede senza mostrarla, e non passa mai dalla riga di comando. Eliminare un
utente chiude anche le sue sessioni.

## Rotte principali

Elenco derivato dal codice, non scritto a mano: 3 rotte senza login, 35 con login e 22 interne.

Senza login, sotto `/api`:

```
GET    /health
POST   /login                               { username, password }
POST   /logout
```

Con login, sotto `/api`:

```
GET    /me                                  utente della sessione
GET    /health/storage                      stato della share, alimenta il banner in UI
GET    /stats                               contatori e avanzamento di ogni fase, per la pagina Stats
GET    /browse/roots
GET    /browse/folder?folder=|root=         breadcrumb + sottocartelle + media paginati
GET    /folders/:id/contents
GET    /media/:id                           dettaglio, EXIF, tag
GET    /thumb/:id/:size?v=<updated>         size = s | m
GET    /media/:id/original                  stream con supporto Range
GET    /search?q=&kind=&from=&to=&tag=&path=

GET    /tags                                elenco con conteggio, per i filtri
GET    /tags/manage?kind=&q=&blocked=       elenco con conteggio, sorgenti e blocco
GET    /tags/kinds
PATCH  /tags/:id                            { display_name, kind, blocked }
POST   /tags/:id/merge                      { into }
POST   /tags/:id/clear                      toglie le assegnazioni e blocca
POST   /media/:id/tags                      { add: [...], remove: [...] }

GET    /others?ext=&sort=                   file che photovault non gestisce
GET    /others/stats
GET    /others/:id/download                 attachment, con Range

GET    /livephotos                          coppie foto/video
POST   /livephotos/trash-videos             cestina i video e tiene le foto

GET    /duplicates?status=&kind=   GET /duplicates/:id   GET /duplicates/stats
POST   /duplicates/:id/resolve

GET    /trash?status=   GET /trash/stats
POST   /trash                               { media_ids, other_ids, folder_ids }

GET    /jobs   POST /jobs   DELETE /jobs/:id
GET    /parameters   POST /parameters
GET    /logs
```

Tutte le rotte paginate accettano `page` e `size` (default 200, massimo 500), oppure `offset` al
posto di `page`: è quello che usa l'infinite scroll, che chiede "dal file N" dove N è quanti ne ha
già, così i file appena cestinati non spostano la pagina successiva.

Protette da bearer token, sotto `/api/internal`:

```
POST   /jobs/claim              { names: [...] }  ← il filtro per nome è obbligatorio
PATCH  /jobs/:id                { status, result }
POST   /jobs                    riaccodamento da parte del cron
POST   /jobs/:id/heartbeat      409 se il job non è più `running`: il pod deve fermarsi
GET    /parameters

GET    /scan/roots
POST   /scan/root               { name, rel_path }
POST   /scan/folder             { root_id, path }  → risolve l'intera catena di antenati
POST   /scan/media/batch        { items: [...] }   → upsert idempotente
POST   /scan/other/batch        { items: [...] }   → file non gestiti
POST   /scan/reconcile          { root_id, started_at }  → applica il guard del 90%

GET    /pending/:stage          stage = thumb | place | label | hash | dhash; ?after=<media_id> per scorrere la coda
POST   /thumb/batch             { items: [{ media_id, thumb_status, ...metadati }] }
POST   /place/batch             { items: [...] }   → tag di luogo e chiusura della coda
POST   /media/not-media         { media_ids }      → sposta fra i file non gestiti
POST   /livephotos/pair         ricalcola gli accoppiamenti Live Photo

POST   /dedup/hashes            { items: [...] }
POST   /dedup/rebuild           raggruppamento + union-find

GET    /trash/pending   GET /trash/expired
POST   /trash/:id/done   POST /trash/:id/purged
```

## Come lo scan rileva le modifiche

Lo scan manda **tutti** i file che incontra, non solo quelli cambiati: è l'`ON CONFLICT` di
`/scan/media/batch` a distinguere i due casi. Questo significa che il pod Go non deve
interrogare il database per fare change detection — cammina, legge e spedisce.

Due colonne distinte reggono il meccanismo:

- **`last_seen`** viene aggiornata a ogni passata, anche sui file immutati. È così che il
  reconcile distingue "non è più sul disco" da "non è stato modificato".
- **`updated`** cambia solo quando il file cambia davvero (dimensione, oppure mtime con un
  secondo di tolleranza). È il token di cache delle thumbnail: se avanzasse a ogni scansione,
  invaliderebbe l'intera cache del browser ogni notte.

Quando un file risulta cambiato, l'upsert azzera in un colpo solo `thumb_status`,
`label_status`, `content_hash`, `dhash` e `dedup_checked`: il media rientra automaticamente
in tutte le code di lavoro.

## Percorsi

Nel database non c'è **nessun percorso assoluto**. `roots.rel_path` è relativo al mount, e il
mount (`MEDIA_ROOT`) è una proprietà del pod: così lo stesso database funziona identico in
sviluppo e sul cluster, e ogni pod compone i percorsi col proprio punto di mount.

Ogni percorso costruito da input esterno passa da `paths.isInsideRoot()` prima di essere
aperto, che respinge il path traversal con un 400.

### Il filtro sul claim

`POST /api/internal/jobs/claim` riceve la lista dei nomi di job che il pod chiamante sa
gestire, e la query filtra con `AND "name" = ANY($1)`.

Senza questo filtro, con più pod che pollano la stessa coda (Go e Python), il primo che si
sveglia si prende i job dell'altro, non trova l'handler e li marca `error`: il labeling non
girerebbe mai, senza alcun errore visibile.

## Thumbnail e cache

Le thumbnail vengono servite da `MEDIA_ROOT/.photovault/thumbs/` con
`Cache-Control: private, max-age=31536000, immutable` ed `ETag` — `private` perché dietro il
login una thumbnail è un dato dell'utente, e una cache condivisa non deve tenerla. L'URL porta un parametro
`?v=<updated>` che cambia se il file cambia, il che rende `immutable` corretto.

Questo sostituisce integralmente la cache IndexedDB di reimagined-disco: non va portata.

Sul percorso di richiesta non si usa mai `statSync`: contro un mount CIFS bloccato blocca
l'event loop, non solo un thread del pool. Si usa `createReadStream` con un handler `error`
che risponde 404 o 503.

## Build

```bash
docker build -f .docker/Dockerfile -t photovault-api:dev .
```

Il push su Docker Hub lo fa la GitHub Action al tag `v*`.
