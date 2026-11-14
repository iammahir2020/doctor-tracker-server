import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // env.ts validates on import, so these must exist before any app code loads.
    // MONGODB_URI is a placeholder; setup.ts connects to an in-memory replica set instead.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:1/unused',
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      CLIENT_ORIGIN: 'http://localhost:3000',
      COOKIE_SECURE: 'false',
    },
    // The first run downloads a MongoDB binary.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
