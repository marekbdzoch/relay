import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// deterministic dates in every worker
process.env.TZ = 'UTC';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
      unstubGlobals: true,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
        reporter: ['text', 'json-summary', 'html'],
        reportsDirectory: './coverage',
      },
    },
  }),
);
