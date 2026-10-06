import { defineConfig, devices } from '@playwright/test';

// Distinct de 8410/8411 pour ne jamais toucher aux données réelles. `WORKLOGS_E2E_PORT` :
// deux copies de travail (worktrees) peuvent lancer leurs parcours en même temps.
const PORT = Number(process.env.WORKLOGS_E2E_PORT) || 8412;

export default defineConfig({
  testDir: './e2e',
  // Un seul worker, séquentiel : les tests partagent la base jetable du serveur.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Base et uploads repartis de zéro à chaque campagne : les tests voient
    // exactement ce que verrait quelqu'un qui lance WorkLogs pour la première fois.
    // `.e2e-share` joue le dossier partagé du TSE : les tests y jouent le collègue.
    command: `rm -rf .e2e-data .e2e-share && mkdir .e2e-share && DATA_DIR=./.e2e-data WORKLOGS_SHARED_ROOT=./.e2e-share PORT=${PORT} node api/src/server.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
