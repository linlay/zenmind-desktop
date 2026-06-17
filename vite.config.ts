import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";
import {
  copyBrandDesktopPetAssets,
  loadBrandConfig,
  resolveBrandId
} from "./scripts/lib/brand-config.mjs";

const projectRoot = path.resolve(__dirname);
const brand = loadBrandConfig(projectRoot, resolveBrandId([], process.env));
const brandDesktopPetRoot = path.resolve(projectRoot, brand.source.desktopPetRoot);

const BRAND_DESKTOP_PET_URL_PREFIX = "/desktop-pet/";
const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

function containsPath(parentPath: string, childPath: string) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveBrandDesktopPetRequestPath(requestUrl: string | undefined) {
  if (!requestUrl) {
    return null;
  }

  let requestPath = "";
  try {
    requestPath = new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return null;
  }

  if (!requestPath.startsWith(BRAND_DESKTOP_PET_URL_PREFIX)) {
    return null;
  }

  let relativePath = "";
  try {
    relativePath = decodeURIComponent(requestPath.slice(BRAND_DESKTOP_PET_URL_PREFIX.length));
  } catch {
    return false;
  }
  const resolvedPath = path.resolve(brandDesktopPetRoot, relativePath);
  if (!relativePath || !containsPath(brandDesktopPetRoot, resolvedPath)) {
    return false;
  }

  return resolvedPath;
}

function serveBrandDesktopPetAsset(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void
) {
  const assetPath = resolveBrandDesktopPetRequestPath(req.url);
  if (assetPath === null) {
    next();
    return;
  }
  if (assetPath === false) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.stat(assetPath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ?? "application/octet-stream");
    const stream = fs.createReadStream(assetPath);
    stream.on("error", next);
    stream.pipe(res);
  });
}

function brandDesktopPetPlugin(): Plugin {
  return {
    name: "brand-desktop-pet-assets",
    configureServer(server) {
      server.watcher.add(brandDesktopPetRoot);
      server.middlewares.use(serveBrandDesktopPetAsset);
    },
    closeBundle() {
      copyBrandDesktopPetAssets({
        rootDir: projectRoot,
        brand,
        outputDir: path.join(projectRoot, "dist-renderer", "desktop-pet")
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [brandDesktopPetPlugin(), react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(projectRoot, "src/renderer"),
      "@shared": path.resolve(projectRoot, "src/shared")
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
