import { syncBuiltinAssets } from "./lib/builtin-assets.mjs";

const platform = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const [key, inlineValue] = arg.split("=");
  const nextValue = inlineValue ?? args[index + 1];
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
  }
}

const manifest = syncBuiltinAssets(process.cwd(), platform);
console.log(`synced ${manifest.length} builtin service assets${platform.os ? ` (${platform.os}/${platform.arch ?? "*"})` : ""}`);
