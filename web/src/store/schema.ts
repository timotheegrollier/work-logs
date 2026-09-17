/**
 * Miroir documenté du schéma SQLite (`api/src/db.js`, table `google_documents`
 * comprise) pour le backend local du navigateur. `api/src/db.js` importe
 * `node:sqlite` et ne peut donc pas être embarqué dans le bundle web : toute
 * divergence avec le schéma serveur doit être répercutée ici (et inversement).
 * Le gabarit du service worker (`web/src/sw-template.js`) en recopie le nom
 * de base, la version et les magasins — y toucher impose de mettre les deux à jour.
 */
export const LOCAL_DB_NAME = 'worklogs';
export const LOCAL_DB_VERSION = 1;

/** Magasin → colonne portant la clé. `task_entries` utilise un id synthétique
 * `${task_id}\0${entry_id}`, comme l'unicité de `api/src/backup.js`. */
export const LOCAL_STORES: Record<string, string> = {
  projects: 'id',
  entries: 'id',
  tasks: 'id',
  task_entries: 'id',
  attachments: 'id',
  google_documents: 'entry_id',
};
