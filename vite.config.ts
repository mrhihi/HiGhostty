import { defineConfig } from "vite";
import { resolve } from "node:path";

// Two pages: the app itself and the standalone preview window.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), preview: resolve(__dirname, "preview.html") },
    },
  },
});
