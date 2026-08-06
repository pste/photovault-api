// Frammenti SQL condivisi fra piu' modelli.
//
// Un file cestinato dalla UI resta in media (o in other_files) finche' il job
// trashapply non lo ha davvero spostato sulla share: fino a un quarto d'ora.
// In quella finestra la riga esiste ma il file, per l'utente, non c'e' piu':
// mostrarlo significherebbe farlo ricomparire a ogni ricaricamento della
// pagina, e permettere di cestinarlo una seconda volta.
//
// Il filtro sta qui, in una costante sola, perche' vale per ogni query che
// mostra file all'utente: griglia, ricerca, anteprime delle cartelle, conteggi
// e pagina degli altri file. Averlo in un posto solo evita che una di queste
// se lo dimentichi.
const NOT_TRASHED_MEDIA = (alias) => `NOT EXISTS (
    SELECT 1 FROM trash tr
    WHERE tr.media_id = ${alias}.media_id AND tr."status" = 'pending')`;

const NOT_TRASHED_OTHER = (alias) => `NOT EXISTS (
    SELECT 1 FROM trash tr
    WHERE tr.other_id = ${alias}.other_id AND tr."status" = 'pending')`;

module.exports = { NOT_TRASHED_MEDIA, NOT_TRASHED_OTHER };
