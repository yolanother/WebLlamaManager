import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import siteThemes from './vite-plugin-site-themes.js';

export default defineConfig({
  plugins: [react(), siteThemes()],
  publicDir: 'public',
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
