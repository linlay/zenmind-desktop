import path from "node:path";
import process from "node:process";
import { build } from "vite";

const projectRoot = process.cwd();

await build({
  configFile: false,
  root: projectRoot,
  logLevel: "warn",
  resolve: {
    alias: {
      chalk: path.join(projectRoot, "src", "bridge", "page-agent-chalk-shim.ts")
    }
  },
  build: {
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: "es2022",
    outDir: path.join(projectRoot, "dist-electron", "main", "assistant"),
    lib: {
      entry: path.join(projectRoot, "src", "bridge", "page-agent-bridge-entry.ts"),
      name: "ZenMindPageAgentBridgeBundle",
      formats: ["iife"],
      fileName: () => "page-agent-bridge.iife.js"
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production")
  }
});
