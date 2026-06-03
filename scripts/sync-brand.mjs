import { syncBrandArtifacts, resolveBrandId } from "./lib/brand-config.mjs";

const brand = syncBrandArtifacts({
  brandId: resolveBrandId()
});

console.log(`synced brand ${brand.id}: ${brand.productName} (${brand.appId})`);
