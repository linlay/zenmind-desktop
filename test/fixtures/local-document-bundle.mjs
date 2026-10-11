import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadBrandConfig, runtimeBrandPayload } from "../../scripts/lib/brand-config.mjs";

// Compile fixtures from current source in isolation. Runtime acceptance must not
// depend on a stale dist-electron build or overwrite another agent's output.
export async function bundleLocalDocumentFixture(fixture, outputDirectory, root) {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const options = {
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"],
    define: {
      __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(projectRoot, "cutej"))),
      "process.env.LOCAL_DOCUMENT_TEST_ROOT": JSON.stringify(root),
    },
  };
  const results = await Promise.allSettled([
    build({ ...options, entryPoints: [fileURLToPath(new URL(fixture, import.meta.url))], outfile: path.join(outputDirectory, "index.cjs") }),
    build({ ...options, entryPoints: [path.join(projectRoot, "src/main/modules/work-panel/local-document-worker.ts")], outfile: path.join(outputDirectory, "local-document-worker.js") }),
    build({ ...options, entryPoints: [path.join(projectRoot, "src/preload/local-document-network.ts")], outfile: path.join(root, "local-document-network.js") }),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return path.join(outputDirectory, "index.cjs");
}
