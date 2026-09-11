import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb, DEFAULT_DATA_DIR } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8410);
const uploadDir = process.env.UPLOAD_DIR || path.join(DEFAULT_DATA_DIR, 'uploads');
const dbPath = process.env.DB_PATH || path.join(DEFAULT_DATA_DIR, 'worklogs.db');

const app = createApp({
  db: openDb(dbPath),
  uploadDir,
  staticDir: path.join(__dirname, '..', '..', 'web', 'dist'),
});

app.listen(PORT, () => {
  console.log(`[worklogs] http://localhost:${PORT}`);
  console.log(`[worklogs] base   : ${dbPath}`);
});
