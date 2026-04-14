/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

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
          "vendor-three": ["three", "3d-force-graph"],
          "vendor-xterm": [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-web-links",
            "@xterm/addon-clipboard",
            "@xterm/addon-unicode-graphemes",
          ],
          "vendor-codemirror": [
            "codemirror",
            "@codemirror/view",
            "@codemirror/state",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/search",
            "@codemirror/autocomplete",
            "@codemirror/lint",
            "@codemirror/theme-one-dark",
          ],
          "vendor-shiki": ["shiki"],
          "vendor-tiptap": ["@tiptap/core", "@tiptap/starter-kit"],
          "vendor-force": ["force-graph", "d3-force"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts",
  },
});
