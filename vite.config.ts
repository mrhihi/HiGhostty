import { defineConfig } from "vite";
import { resolve } from "node:path";

// Three pages: the app itself, the standalone preview window and the popped-out files panel.
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), preview: resolve(__dirname, "preview.html"), files: resolve(__dirname, "files.html") },
    },
  },
});
