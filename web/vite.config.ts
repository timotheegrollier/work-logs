import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 8411, proxy: { '/api': 'http://localhost:8410' } },
  preview: { port: 8411 },
});
