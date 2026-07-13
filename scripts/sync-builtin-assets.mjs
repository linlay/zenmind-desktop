import { syncBuiltinAssets } from "./lib/builtin-assets.mjs";

const platform = { sourceRoots: [] };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const [key, inlineValue] = arg.split("=");
  const nextValue = inlineValue ?? args[index + 1];
  if (key === "--sign-darwin") {
    platform.signDarwin = true;
    continue;
  }
  if (key === "--use-existing") {
    platform.useExisting = true;
    continue;
  }
  if (key === "--os") {
    platform.os = nextValue;
    if (inlineValue === undefined) {
      index += 1;
    }
    continue;
  }
  if (key === "--arch") {
    platform.arch = nextValue;
    if (inlineValue === undefined) {
      index += 1;
    }
    continue;
  }
  if (key === "--source") {
    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error("--source requires a release directory");
    }
    platform.sourceRoots.push(nextValue);
    if (inlineValue === undefined) {
      index += 1;
    }
    continue;
  }
  throw new Error(`unknown argument: ${arg}`);
}

try {
  const manifest = syncBuiltinAssets(process.cwd(), platform);
  const action = platform.useExisting ? "validated existing" : "synced";
  console.log(`${action} ${manifest.length} builtin service assets${platform.os ? ` (${platform.os}/${platform.arch ?? "*"})` : ""}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
