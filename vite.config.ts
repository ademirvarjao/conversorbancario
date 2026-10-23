import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  resolve: {
    alias:
      mode === 'test'
        ? []
        : [
            {
              find: /^exceljs$/,
              replacement: resolve(rootDir, 'node_modules/exceljs/dist/exceljs.min.js'),
            },
          ],
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
}));
