import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createVerify, generateKeyPairSync } from "node:crypto";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  ensureKeyPairForPan,
  getPanAuthStatus,
  importPanPrivateKey
} = require("../dist-electron/main/pan-auth.js");

function createAppStub(userDataRoot) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function decodeJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("parseRsaPrivateKey rejects invalid private key content", () => {
  assert.throws(
    () => __testInternals.parseRsaPrivateKey("not-a-private-key"),
    /private key|RSA|PEM|decoder|unsupported/i
  );
});

test("createDesktopAccessToken produces RS256 jwt for desktop-app subject", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const keyObject = __testInternals.parseRsaPrivateKey(privateKeyPem);
  const token = __testInternals.createDesktopAccessToken(keyObject, 1_700_000_000_000);
  const [headerPart, payloadPart, signaturePart] = token.split(".");

  assert.equal(decodeJson(headerPart).alg, "RS256");
  assert.equal(decodeJson(payloadPart).sub, "desktop-app");
  assert.equal(decodeJson(payloadPart).exp, 1_700_000_000 + 300);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  assert.equal(
    verifier.verify(publicKey, Buffer.from(signaturePart, "base64url")),
    true
  );
});

test("ensureKeyPairForPan generates and then reuses the shared rsa key pair", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pan-auth-"));
  const app = createAppStub(tempRoot);

  try {
    const first = ensureKeyPairForPan(app);
    assert.match(first.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.equal(fs.existsSync(first.privateKeyPath), true);
    assert.deepEqual(getPanAuthStatus(app), {
      configured: true,
      path: first.privateKeyPath,
      message: "Desktop App 私钥已就绪。"
    });

    const second = ensureKeyPairForPan(app);
    assert.equal(second.privateKeyPath, first.privateKeyPath);
    assert.equal(second.publicKeyPem, first.publicKeyPem);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("importPanPrivateKey validates and installs the rsa private key", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pan-auth-import-"));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pan-auth-source-"));
  const app = createAppStub(tempRoot);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sourcePath = path.join(sourceDir, "desktop-app.pem");
  fs.writeFileSync(
    sourcePath,
    privateKey.export({ type: "pkcs1", format: "pem" }),
    "utf8"
  );

  try {
    const status = importPanPrivateKey(app, sourcePath);
    assert.equal(status.configured, true);
    assert.equal(fs.existsSync(status.path), true);
    assert.deepEqual(getPanAuthStatus(app), {
      configured: true,
      path: status.path,
      message: "Desktop App 私钥已就绪。"
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});
