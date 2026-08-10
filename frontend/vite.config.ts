import path from "path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// Test configuration lives in `vitest.config.ts`, which takes precedence over
// this file and deliberately runs without the solid/tailwind plugins.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // The addons this app actually imports. `addon-web-links` and
          // `addon-clipboard` used to be listed here and are imported by
          // nothing in `src` — meanwhile `addon-webgl`, the largest of them,
          // was missing and landed in the app chunk instead.
          //
          // `addon-ligatures` is deliberately absent: it is loaded through a
          // dynamic `import()` so it stays out of the startup cost for the
          // users who leave the setting off, and naming it here would defeat
          // that by pulling it into an eagerly-loaded chunk.
          "vendor-xterm": [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-webgl",
            "@xterm/addon-unicode-graphemes",
          ],
        },
      },
    },
  },
});
