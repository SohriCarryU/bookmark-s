import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // Preserve the browser-facing Host so API same-origin checks stay valid.
        // Vite's string shorthand enables changeOrigin and breaks this check.
        changeOrigin: false,
      },
    },
  },
});
