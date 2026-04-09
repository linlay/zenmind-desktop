import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { App, Cookies } from "electron";
import type { PanAuthEnsureResult, PanAuthStatus } from "../shared/contracts";

const PAN_PRIVATE_KEY_FILE_NAME = "pan-app-private-key.pem";
const PAN_SESSION_CHECK_PATH = "/pan/api/web/session/me";
const PAN_SESSION_EXCHANGE_PATH = "/pan/api/app/session/exchange";
const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;

type FetchLike = typeof fetch;

type SessionExchangePayload = {
  ok: boolean;
  username: string;
  sessionCookieName: string;
  sessionToken: string;
  maxAgeSeconds: number;
  expiresAt: number;
};

type CookieLike = {
  name: string;
  value: string;
};

type CookieStoreLike = Pick<Cookies, "get" | "set">;

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function encodeBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function getCredentialsDir(app: App) {
  return path.join(app.getPath("userData"), "credentials");
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

function resolveCookieUrl(webUrl: string) {
  return new URL("/", webUrl).toString();
}

function resolveSessionCheckUrl(webUrl: string) {
  return new URL(PAN_SESSION_CHECK_PATH, webUrl).toString();
}

function resolveSessionExchangeUrl(webUrl: string) {
  return new URL(PAN_SESSION_EXCHANGE_PATH, webUrl).toString();
}

function buildCookieHeader(cookies: CookieLike[]) {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function parseJsonResponse(response: Response) {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload;
}

async function sessionIsHealthy(webUrl: string, cookies: CookieLike[], fetchImpl: FetchLike) {
  const cookieHeader = buildCookieHeader(cookies);
  if (!cookieHeader) {
    return false;
  }

  const response = await fetchImpl(resolveSessionCheckUrl(webUrl), {
    headers: {
      Cookie: cookieHeader
    }
  });

  return response.ok;
}

function createDesktopAccessToken(privateKey: KeyObject, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({ sub: "desktop-app", exp }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function exchangeSession(webUrl: string, accessToken: string, fetchImpl: FetchLike) {
  const response = await fetchImpl(resolveSessionExchangeUrl(webUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const payload = await parseJsonResponse(response);
    throw new Error(payload?.message ?? `${response.status} ${response.statusText}`);
  }

  return (await response.json()) as SessionExchangePayload;
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

export async function ensurePanSession(
  app: App,
  cookies: CookieStoreLike,
  webUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<PanAuthEnsureResult> {
  try {
    const status = getPanAuthStatus(app);
    if (!status.configured) {
      return {
        ok: false,
        refreshed: false,
        message: status.message
      };
    }

    const cookieUrl = resolveCookieUrl(webUrl);
    const existingCookies = await cookies.get({ url: cookieUrl });
    if (await sessionIsHealthy(webUrl, existingCookies, fetchImpl)) {
      return {
        ok: true,
        refreshed: false,
        message: "Desktop 网盘会话已就绪。"
      };
    }

    const privateKey = readRsaPrivateKey(status.path);
    const accessToken = createDesktopAccessToken(privateKey);
    const payload = await exchangeSession(webUrl, accessToken, fetchImpl);
    await cookies.set({
      url: cookieUrl,
      name: payload.sessionCookieName,
      value: payload.sessionToken,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expirationDate: payload.expiresAt
    });

    return {
      ok: true,
      refreshed: true,
      message: "已建立 Desktop 网盘会话。"
    };
  } catch (reason) {
    return {
      ok: false,
      refreshed: false,
      message: reason instanceof Error ? reason.message : String(reason)
    };
  }
}

export const __testInternals = {
  buildCookieHeader,
  createDesktopAccessToken,
  exchangeSession,
  getPanPrivateKeyPath,
  parseRsaPrivateKey,
  resolveSessionCheckUrl,
  resolveSessionExchangeUrl,
  sessionIsHealthy
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
