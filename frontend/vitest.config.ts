import path from "path";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

/// Deliberately separate from `vite.config.ts`: the app build needs tailwind,
/// the test run does not.
///
/// Three projects, because there are three kinds of test and each wants a
/// different amount of environment under it.
///
///   * **unit** — every `.test.ts`. Pure logic: stores, reducers, parsers, the
///     lane algorithm. No DOM, no Solid compiler, no per-file jsdom
///     construction. This is the overwhelming majority of the suite and it is
///     fast precisely because none of that is set up.
///   * **render** — every `.test.tsx`. Real components, mounted in jsdom.
///   * **browser** — every `.browser.test.tsx`. Real components, mounted in a
///     real headless Chromium via Playwright. jsdom has no layout engine:
///     `getBoundingClientRect` returns zeroes, there is no scrolling and no
///     real CSS cascade, and `IntersectionObserver`/`ResizeObserver` are
///     stubs. Every surface whose correctness *is* its geometry — the
///     `@tanstack/solid-virtual` lists (commit graph, diff renderer, file
///     tree), tab-strip overflow, the splitter, sticky headers, the MRU
///     overlay, xterm, Monaco — is untestable in `render` for that one
///     reason. This project exists so those surfaces have somewhere to be
///     proven rather than mocked into passing.
///
/// Splitting unit from render keeps the ~850 unit tests at the speed they
/// had, and makes the extension say which kind of test a file is: `.test.ts`
/// is pure logic, `.test.tsx` mounts something in jsdom, `.browser.test.tsx`
/// mounts something in a real browser. Three suffixes, three costs, and the
/// filename says which you are paying — `npm test` runs only the first two,
/// because the browser project is roughly two orders of magnitude slower per
/// test and a suite that takes minutes stops being run. Reach for it with
/// `npm run test:browser`, or when a change touches one of the surfaces above.
///
/// `vite-plugin-solid` is loaded by the render and browser projects, together
/// with `resolve.conditions`. Solid reached through two different resolutions
/// in one process yields two copies of the reactive runtime, whose symptom is
/// an `undefined` dispose or an owner that never cleans up — a failure that
/// reads as a bug in the component under test. See Solid Testing Library's
/// "Known issues".
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
          // `*.browser.test.tsx` also matches `*.test.tsx` — glob suffix
          // matching is not mutually exclusive by itself, so without this a
          // browser test would run *twice*: once for real in `browser`, once
          // against jsdom's zeroed-out geometry here, where it can only fail.
          // `exclude` replaces Vitest's own default (just `node_modules` and
          // `.git` as of v4) rather than adding to it, so `configDefaults.exclude`
          // has to be spread back in.
          exclude: [...configDefaults.exclude, "src/**/*.browser.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
      {
        extends: true,
        // `tailwindcss()` here, unlike in the render project, is not
        // optional. Real geometry needs the real cascade: `overflow-auto`,
        // `flex-1` and `h-full` are exactly what makes the commit graph's
        // scroll container clip and scroll for real, and a windowing test
        // that never actually clips is not testing windowing. `setup.browser.ts`
        // imports the app's `index.css` so the classes resolve to rules.
        plugins: [solid(), tailwindcss()],
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./src"),
          },
          conditions: ["development", "browser"],
        },
        test: {
          name: { label: "browser", color: "cyan" },
          include: ["src/**/*.browser.test.tsx"],
          setupFiles: ["./src/test/setup.browser.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium", viewport: { width: 1440, height: 900 } }],
          },
        },
      },
    ],
  },
});
