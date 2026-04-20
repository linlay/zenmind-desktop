import fs from "node:fs";
import path from "node:path";
import { safeStorage, type App } from "electron";
import { getCredentialsRoot } from "./user-paths";

const QIUER_LOGIN_FILE = "qiuer-login.json";

export interface QiuerLoginCredentials {
  account: string;
  password: string;
  updatedAt: number;
}

interface StoredQiuerLoginCredentials {
  account: string;
  encryptedPassword: string;
  updatedAt: number;
}

function getQiuerLoginPath(app: App) {
  return path.join(getCredentialsRoot(app), QIUER_LOGIN_FILE);
}

function readStoredQiuerLogin(app: App): StoredQiuerLoginCredentials | null {
  const targetPath = getQiuerLoginPath(app);
  if (!fs.existsSync(targetPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8")) as Partial<StoredQiuerLoginCredentials>;
    if (
      typeof parsed.account !== "string" ||
      typeof parsed.encryptedPassword !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      account: parsed.account,
      encryptedPassword: parsed.encryptedPassword,
      updatedAt: parsed.updatedAt
    };
  } catch (error) {
    console.warn("failed to read qiuer login credentials", error);
    return null;
  }
}

export function getQiuerLoginCredentials(app: App) {
  const stored = readStoredQiuerLogin(app);
  if (!stored) {
    return {
      ok: true,
      credentials: null,
      message: "未保存秋而登录凭据。"
    };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      credentials: null,
      message: "当前系统安全存储不可用，无法读取已保存的秋而密码。"
    };
  }
  try {
    return {
      ok: true,
      credentials: {
        account: stored.account,
        password: safeStorage.decryptString(Buffer.from(stored.encryptedPassword, "base64")),
        updatedAt: stored.updatedAt
      },
      message: "已读取秋而登录凭据。"
    };
  } catch (error) {
    return {
      ok: false,
      credentials: null,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function saveQiuerLoginCredentials(app: App, credentials: { account: string; password: string }) {
  const account = credentials.account.trim();
  const password = credentials.password;
  if (!account || !password) {
    return {
      ok: false,
      message: "账号和密码不能为空。"
    };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      message: "当前系统安全存储不可用，未保存秋而密码。"
    };
  }

  const updatedAt = Date.now();
  const encryptedPassword = safeStorage.encryptString(password).toString("base64");
  const targetPath = getQiuerLoginPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    `${JSON.stringify({ account, encryptedPassword, updatedAt }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.chmodSync(targetPath, 0o600);

  return {
    ok: true,
    message: "已保存秋而登录凭据。"
  };
}
