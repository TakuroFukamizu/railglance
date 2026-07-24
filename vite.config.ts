import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    allowedHosts: true, // Allow ngrok and external hosts (Vite 6 security option)
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
