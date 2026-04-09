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
  ensurePanSession,
  getPanPrivateKeyPath
} = require("../dist-electron/main/pan-auth.js");

function createAppStub(userDataRoot) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function createCookieStore() {
  const store = [];
  return {
    async get() {
      return [...store];
    },
    async set(details) {
      const next = {
        name: details.name,
        value: details.value
      };
      const index = store.findIndex((cookie) => cookie.name === next.name);
      if (index >= 0) {
        store[index] = next;
      } else {
        store.push(next);
      }
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

test("ensurePanSession exchanges session and reuses healthy cookies", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pan-auth-"));
  const app = createAppStub(tempRoot);
  const cookieStore = createCookieStore();
  const privateKeyPath = getPanPrivateKeyPath(app);
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
  fs.writeFileSync(privateKeyPath, privateKeyPem, "utf8");

  let exchangeCount = 0;
  let sessionCheckCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers ?? undefined);
    if (url === "http://127.0.0.1:8080/pan/api/web/session/me") {
      sessionCheckCount += 1;
      if (headers.get("Cookie") === "pan_session=desktop-session") {
        return new Response(JSON.stringify({ username: "desktop-app", authMethod: "session" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ message: "missing or invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url === "http://127.0.0.1:8080/pan/api/app/session/exchange") {
      exchangeCount += 1;
      assert.match(String(headers.get("Authorization")), /^Bearer .+\..+\..+$/);
      return new Response(
        JSON.stringify({
          ok: true,
          username: "desktop-app",
          sessionCookieName: "pan_session",
          sessionToken: "desktop-session",
          maxAgeSeconds: 86400,
          expiresAt: Math.floor(Date.now() / 1000) + 86400
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response("", { status: 404 });
  };
  const webUrl = "http://127.0.0.1:8080/pan/";

  try {
    const first = await ensurePanSession(app, cookieStore, webUrl, fetchImpl);
    assert.deepEqual(first, {
      ok: true,
      refreshed: true,
      message: "已建立 Desktop 网盘会话。"
    });
    assert.equal(exchangeCount, 1);

    const second = await ensurePanSession(app, cookieStore, webUrl, fetchImpl);
    assert.deepEqual(second, {
      ok: true,
      refreshed: false,
      message: "Desktop 网盘会话已就绪。"
    });
    assert.equal(exchangeCount, 1);
    assert.equal(sessionCheckCount, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensurePanSession surfaces exchange failures", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pan-auth-fail-"));
  const app = createAppStub(tempRoot);
  const cookieStore = createCookieStore();
  const privateKeyPath = getPanPrivateKeyPath(app);
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
  fs.writeFileSync(privateKeyPath, privateKeyPem, "utf8");

  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:8080/pan/api/web/session/me") {
      return new Response(JSON.stringify({ message: "missing or invalid credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url === "http://127.0.0.1:8080/pan/api/app/session/exchange") {
      return new Response(JSON.stringify({ message: "token expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("", { status: 404 });
  };
  const webUrl = "http://127.0.0.1:8080/pan/";

  try {
    const result = await ensurePanSession(app, cookieStore, webUrl, fetchImpl);
    assert.deepEqual(result, {
      ok: false,
      refreshed: false,
      message: "token expired"
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
