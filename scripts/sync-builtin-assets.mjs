import { syncBuiltinAssets } from "./lib/builtin-assets.mjs";

const platform = {};
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.split("=");
  if (key === "--os") platform.os = value;
  if (key === "--arch") platform.arch = value;
}

const manifest = syncBuiltinAssets(process.cwd(), platform);
console.log(`synced ${manifest.length} builtin service assets${platform.os ? ` (${platform.os}/${platform.arch ?? "*"})` : ""}`);
