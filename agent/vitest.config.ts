import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    threads: false, // Ensure stable single-threaded headless browser test execution
  },
});
