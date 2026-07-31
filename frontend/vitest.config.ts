import path from "path";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/// Deliberately separate from `vite.config.ts`: the app build needs tailwind,
/// the test run does not.
///
/// Two projects, because the two kinds of test want opposite things.
///
///   * **unit** — every `.test.ts`. Pure logic: stores, reducers, parsers, the
///     lane algorithm. No DOM, no Solid compiler, no per-file jsdom
///     construction. This is the overwhelming majority of the suite and it is
///     fast precisely because none of that is set up.
///   * **render** — every `.test.tsx`. Real components, mounted in jsdom.
///
/// Splitting them rather than running everything in jsdom keeps the ~850 unit
/// tests at the speed they had, and makes the extension say which kind of test
/// a file is: if it ends in `.tsx` it mounts something.
///
/// `vite-plugin-solid` is loaded **only** by the render project, together with
/// `resolve.conditions`. Solid reached through two different resolutions in one
/// process yields two copies of the reactive runtime, whose symptom is an
/// `undefined` dispose or an owner that never cleans up — a failure that reads
/// as a bug in the component under test. See Solid Testing Library's "Known
/// issues".
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: { label: "unit", color: "green" },
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [solid()],
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./src"),
          },
          conditions: ["development", "browser"],
        },
        test: {
          name: { label: "render", color: "magenta" },
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
