/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Only the pure logic is under test — the keymap table, the event matcher,
  // and the accelerator formatter. None of it touches the DOM, so `node` is
  // the right environment and no component-testing harness is needed.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
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
