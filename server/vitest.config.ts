import { defineConfig } from "vitest/config";

// Without an explicit include, vitest's default glob also picks up the
// compiled dist/*.test.js from a local `npm run build` — every suite then
// runs TWICE, the second copy frozen at whatever the code was at build time
// (live 2026-06-12: stale dist tests green-lit behavior the src had already
// changed). Tests run from src only.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
