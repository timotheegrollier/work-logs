import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb, DEFAULT_DATA_DIR } from './db.js';
import { createSharedService, instanceId } from './shared-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8410);
const uploadDir = process.env.UPLOAD_DIR || path.join(DEFAULT_DATA_DIR, 'uploads');
const dbPath = process.env.DB_PATH || path.join(DEFAULT_DATA_DIR, 'worklogs.db');

const db = openDb(dbPath);
// Dossier partagé en mode web : seulement s'il est fixé par l'environnement
// (dev, recettes e2e). Le desktop le choisit par son dialogue natif.
const sharedRoot = process.env.WORKLOGS_SHARED_ROOT ? path.resolve(process.env.WORKLOGS_SHARED_ROOT) : null;
const shared = sharedRoot
  ? createSharedService({ db, blobDir: path.join(DEFAULT_DATA_DIR, 'shared-blobs'), root: sharedRoot, instance: instanceId(DEFAULT_DATA_DIR) })
  : null;

const app = createApp({
  db,
  uploadDir,
  staticDir: path.join(__dirname, '..', '..', 'web', 'dist'),
  shared,
});

app.listen(PORT, () => {
  console.log(`[worklogs] http://localhost:${PORT}`);
  console.log(`[worklogs] base   : ${dbPath}`);
  if (sharedRoot) console.log(`[worklogs] partage: ${sharedRoot}`);
});
