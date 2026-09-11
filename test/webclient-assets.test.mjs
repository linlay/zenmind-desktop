import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWebclientAssetFingerprint, verifyWebclientAssets } from "../scripts/verify-webclient-assets.mjs";

test("WebClient provenance checks bytes and lazy chunks, not version labels", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "webclient-provenance-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const reference = path.join(temp, "reference"), candidate = path.join(temp, "candidate");
  fs.mkdirSync(path.join(reference, "js"), { recursive: true });
  fs.mkdirSync(path.join(reference, "css"));
  fs.writeFileSync(path.join(reference, "index.html"), '<script src="/runtime-config.js"></script><script src="/js/main.hash.js"></script><link href="/css/main.hash.css">');
  fs.writeFileSync(path.join(reference, "js/main.hash.js"), "new build");
  fs.writeFileSync(path.join(reference, "js/lazy.hash.js"), "lazy build");
  fs.writeFileSync(path.join(reference, "css/main.hash.css"), "body{}");
  fs.cpSync(reference, candidate, { recursive: true });
  assert.equal(verifyWebclientAssets(reference, [candidate]).verified, 1);
  fs.writeFileSync(path.join(candidate, "js/lazy.hash.js"), "stale build, same version");
  assert.throws(() => verifyWebclientAssets(reference, [candidate]), /lazy.hash.js/u);
  fs.unlinkSync(path.join(candidate, "css/main.hash.css"));
  assert.throws(() => readWebclientAssetFingerprint(candidate), /ENOENT/u);
});
