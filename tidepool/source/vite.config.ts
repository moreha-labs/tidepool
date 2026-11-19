import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained index.html, so the site can be hosted on GitHub Pages
// by uploading a single file.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: { target: "es2020" },
});
