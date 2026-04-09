import { syncBuiltinAssets } from "./lib/builtin-assets.mjs";

const manifest = syncBuiltinAssets(process.cwd());
console.log(`synced ${manifest.length} builtin service assets`);
