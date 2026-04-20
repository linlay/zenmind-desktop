import { syncBuiltinAssets } from "./lib/builtin-assets.mjs";
import { syncCodeAssistantRuntime } from "./lib/code-assistant-runtime.mjs";

const platform = {};
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key === "--os") platform.os = value;
  if (key === "--arch") platform.arch = value;
  if (key === "--source") platform.sourceRoot = value;
  if (key === "--bun") platform.bunPath = value;
}

const manifest = syncBuiltinAssets(process.cwd(), platform);
const runtimeManifest = syncCodeAssistantRuntime(process.cwd(), platform);
const platformLabel = platform.os ? ` (${platform.os}/${platform.arch ?? "*"})` : "";

console.log(`synced ${manifest.length} builtin service assets${platformLabel}`);
if (runtimeManifest?.skipped) {
  console.log(
    `skipped code assistant runtime${platformLabel} (reason: ${runtimeManifest.reason})`
  );
} else {
  console.log(`synced code assistant runtime${platformLabel} from ${runtimeManifest.sourceRoot}`);
}
