/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
