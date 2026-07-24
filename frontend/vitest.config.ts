import path from "path";
import { defineConfig } from "vitest/config";

/// Deliberately separate from `vite.config.ts`: the app build needs the solid
/// and tailwind plugins, the test run does not. The only thing tested today is
/// the pure store migration, which touches no DOM — hence the `node`
/// environment and the narrow `include`. This is not a component test harness.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
