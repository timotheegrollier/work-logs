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
    // Un worker par fichier (54) saturait les 8 cœurs locaux et les 4 de la CI :
    // les attentes DOM expiraient sous charge. Quatre workers gardent
    // l'isolation par fichier sans écraser la machine.
    maxWorkers: 4,
    // Les tests d'App font de vrais allers-retours : sous charge, une attente
    // peut expirer une fois. On rejoue le test une fois ; une régression
    // réelle échoue aux deux passages.
    retry: 1,
    // L'API réelle est chargée par Node, pas transformée par Vite : les tests
    // du front tapent sur le vrai backend et ne peuvent donc pas en diverger.
    server: { deps: { external: [/[\\/]api[\\/]src[\\/]/] } },
  },
});
