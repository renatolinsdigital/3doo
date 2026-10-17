import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Kept apart from `npm test`: this needs Chrome and a real GPU, and takes
// minutes rather than seconds. Run it with `npm run test:gpu`.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['gpu/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
