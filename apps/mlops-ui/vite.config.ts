import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  root: appRoot,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(appRoot, "dist"),
    emptyOutDir: true,
  },
});
