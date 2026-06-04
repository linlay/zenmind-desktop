import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

test("public brand icon assets exist in the public directory", () => {
  const brandIconPath = path.join(projectRoot, "public", "brand-icon.png");
  const trayIconPngPath = path.join(projectRoot, "public", "tray-icon.png");
  const trayIconSvgPath = path.join(projectRoot, "public", "tray-icon.svg");

  assert.ok(fs.existsSync(brandIconPath), `Missing generated brand icon at: ${brandIconPath}`);
  assert.ok(fs.existsSync(trayIconPngPath), `Missing generated tray icon PNG at: ${trayIconPngPath}`);
  assert.ok(fs.existsSync(trayIconSvgPath), `Missing generated tray icon SVG at: ${trayIconSvgPath}`);
});
