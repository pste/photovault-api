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

// Una cartella e' "in cestino" anche quando lo e' un suo antenato: la rename
// sposta l'intero sottoalbero, quindi mostrare una sottocartella di una
// cartella cestinata sarebbe mostrare qualcosa che sul disco non c'e' piu'.
//
// Il confronto per prefisso e' starts_with e mai LIKE path || '%': in LIKE il
// carattere _ e' un jolly, e "2019_01/" corrisponderebbe anche a "2019-01/".
// Con lo stesso confronto completeTrash cancellava le righe della cartella
// sorella. Vale per ogni sottoalbero: il path finisce sempre con '/', quindi
// il prefisso non puo' fermarsi a meta' di un nome.
const NOT_TRASHED_FOLDER = (alias) => `NOT EXISTS (
    SELECT 1 FROM trash tr
    JOIN folders tf ON tf.folder_id = tr.folder_id
    WHERE tr."status" = 'pending'
      AND tf.root_id = ${alias}.root_id
      AND starts_with(${alias}."path", tf."path"))`;

module.exports = { NOT_TRASHED_MEDIA, NOT_TRASHED_OTHER, NOT_TRASHED_FOLDER };
