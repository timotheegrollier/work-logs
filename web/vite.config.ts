/// <reference types="vitest/config" />
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La version affichée dans l'interface est celle du paquet racine — la même
// que l'application desktop compare aux releases GitHub pour les mises à jour.
const rootVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  // Chemins relatifs : le même `dist/` tourne à la racine (desktop, `npm start`,
  // recettes e2e) et dans un sous-dossier (PWA sur gh-pages).
  base: './',
  define: { __WORKLOGS_VERSION__: JSON.stringify(rootVersion) },
  server: { port: 8411, proxy: { '/api': 'http://localhost:8410' } },
  preview: { port: 8411 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.{ts,tsx}'],
    // L'API réelle est chargée par Node, pas transformée par Vite : les tests
    // du front tapent sur le vrai backend et ne peuvent donc pas en diverger.
    server: { deps: { external: [/[\\/]api[\\/]src[\\/]/] } },
  },
});
