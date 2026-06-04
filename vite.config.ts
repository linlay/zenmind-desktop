import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@shared": path.resolve(__dirname, "src/shared")
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/.cache/**",
        "**/.vite/**",
        "**/build/**",
        "**/coverage/**",
        "**/dist/**",
        "**/dist-electron/**",
        "**/dist-renderer/**",
        "**/out/**",
        "**/release/**",
        "**/tmp/**"
      ]
    }
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true
  }
});
