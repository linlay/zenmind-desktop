import fs from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createSign,
  type KeyObject
} from "node:crypto";
import type { App } from "electron";
import type { PanAuthStatus } from "../shared/contracts";
import { getCredentialsRoot } from "./user-paths";

const PAN_PRIVATE_KEY_FILE_NAME = "pan-app-private-key.pem";
const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function encodeBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function getCredentialsDir(app: App) {
  return getCredentialsRoot(app);
}

export function getPanPrivateKeyPath(app: App) {
  return path.join(getCredentialsDir(app), PAN_PRIVATE_KEY_FILE_NAME);
}

function parseRsaPrivateKey(content: string): KeyObject {
  const key = createPrivateKey(content);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("导入的 App 私钥不是 RSA 私钥。");
  }
  return key;
}

function readRsaPrivateKey(filePath: string): KeyObject {
  const content = fs.readFileSync(filePath, "utf8");
  return parseRsaPrivateKey(content);
}

export function readPanPrivateKey(app: App): KeyObject {
  return readRsaPrivateKey(getPanPrivateKeyPath(app));
}

export function createDesktopAccessToken(privateKey: KeyObject, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({ sub: "desktop-app", exp }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function getPanAuthStatus(app: App): PanAuthStatus {
  const filePath = getPanPrivateKeyPath(app);
  if (!fs.existsSync(filePath)) {
    return {
      configured: false,
      path: filePath,
      message: "尚未导入 Desktop App 私钥。"
    };
  }

  try {
    readRsaPrivateKey(filePath);
    return {
      configured: true,
      path: filePath,
      message: "Desktop App 私钥已就绪。"
    };
  } catch (reason) {
    return {
      configured: false,
      path: filePath,
      message: reason instanceof Error ? reason.message : String(reason)
    };
  }
}

export function importPanPrivateKey(app: App, sourcePath: string): PanAuthStatus {
  const targetPath = getPanPrivateKeyPath(app);
  const content = fs.readFileSync(sourcePath, "utf8");
  parseRsaPrivateKey(content);
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, { encoding: "utf8", mode: 0o600 });
  return {
    configured: true,
    path: targetPath,
    message: "Desktop App 私钥已导入。"
  };
}

export const __testInternals = {
  createDesktopAccessToken,
  getPanPrivateKeyPath,
  parseRsaPrivateKey
};

/**
 * Ensure a RSA key pair exists for desktop ↔ pan-webclient auth.
 * If the private key file is missing, generate a new 2048-bit RSA pair,
 * save the private key, and return the public key PEM.
 * If the private key already exists, derive and return the public key.
 */
export function ensureKeyPairForPan(app: App): { privateKeyPath: string; publicKeyPem: string } {
  const { generateKeyPairSync, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
  const privateKeyPath = getPanPrivateKeyPath(app);

  if (fs.existsSync(privateKeyPath)) {
    const key = readRsaPrivateKey(privateKeyPath);
    const pub = createPublicKey(key);
    const publicKeyPem = pub.export({ type: "spki", format: "pem" }) as unknown as string;
    return { privateKeyPath, publicKeyPem };
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }) as unknown as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as unknown as string;

  ensureDir(path.dirname(privateKeyPath));
  fs.writeFileSync(privateKeyPath, privatePem, { encoding: "utf8", mode: 0o600 });

  return { privateKeyPath, publicKeyPem: publicPem };
}
