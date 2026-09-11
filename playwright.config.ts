import { defineConfig, devices } from '@playwright/test';

const PORT = 8412; // distinct de 8410/8411 pour ne jamais toucher aux données réelles

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
    command: `rm -rf .e2e-data && DATA_DIR=./.e2e-data PORT=${PORT} node api/src/server.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
