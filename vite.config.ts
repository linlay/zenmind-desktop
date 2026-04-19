import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(__dirname, "src/renderer/assistant-webclient")}/`
      },
      {
        find: "@renderer",
        replacement: path.resolve(__dirname, "src/renderer")
      },
      {
        find: "@shared",
        replacement: path.resolve(__dirname, "src/shared")
      }
    ]
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true
  }
});
