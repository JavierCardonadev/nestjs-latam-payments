import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits decorator metadata, which NestJS dependency injection relies on.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts', ...(process.env.LIVE ? ['test/live/**/*.live.ts'] : [])],
    setupFiles: ['reflect-metadata'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/interfaces.ts', 'src/core/types.ts', 'src/core/provider.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
