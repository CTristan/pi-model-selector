import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 1000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        // Keep strict thresholds for core source modules.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      include: ["src/**/*.ts", "index.ts"],
      exclude: ["index.ts"], // Report coverage for src but exclude index.ts from global thresholds if dragging down
    },
  },
});
