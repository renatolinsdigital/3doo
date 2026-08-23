import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': alias('./src'),
      '@kernel': alias('./src/kernel'),
      '@shared': alias('./src/shared'),
      '@domain': alias('./src/domain'),
      '@store': alias('./src/store'),
      '@viewport': alias('./src/viewport'),
      '@bridge': alias('./src/bridge'),
      '@global-styles': alias('./src/global-styles'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler' },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/kernel/**/*.ts', 'src/shared/**/*.tsx', 'src/domain/**/*.ts'],
      exclude: ['**/*.test.*', '**/index.ts'],
    },
  },
});
