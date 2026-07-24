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
          "vendor-xterm": [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-web-links",
            "@xterm/addon-clipboard",
            "@xterm/addon-unicode-graphemes",
          ],
          "vendor-monaco": ["monaco-editor"],
        },
      },
    },
  },
});
