import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist/web", emptyOutDir: true },
});
