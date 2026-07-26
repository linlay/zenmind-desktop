import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  getDesktopWebappInstallBackupRoot,
  getDesktopWebappInstallStagingRoot,
  getDesktopWebappStateRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebappsStateRoot
} from "../../user-paths";

const TRANSACTION_FILE = "install-transaction.json";
const RENAME_RETRY_COUNT = 5;
const RENAME_RETRY_DELAY_MS = 100;

type InstallTransactionPhase = "prepared" | "backed-up" | "activated";

export type WebappInstallTransaction = {
  schemaVersion: 1;
  id: string;
  phase: InstallTransactionPhase;
  hadExisting: boolean;
  installPath: string;
  stagingPath: string;
  backupPath: string;
  updatedAt: string;
};

function transactionPath(app: App, id: string) {
  return path.join(getDesktopWebappStateRoot(app, id), TRANSACTION_FILE);
}

function writeTransaction(app: App, transaction: WebappInstallTransaction) {
  const filePath = transactionPath(app, transaction.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
}

function waitForRenameRetry() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAY_MS);
}

function renameWithRetry(sourcePath: string, targetPath: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRY_COUNT; attempt += 1) {
    try {
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32") {
        break;
      }
      waitForRenameRetry();
    }
  }
  throw lastError;
}

function removeIfExists(targetPath: string) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function pathIsInside(parentPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isSafeTransaction(app: App, transaction: WebappInstallTransaction) {
  const expectedInstallPath = path.join(getDesktopWebappsDataRoot(app), transaction.id);
  return path.resolve(transaction.installPath) === path.resolve(expectedInstallPath) &&
    pathIsInside(getDesktopWebappInstallStagingRoot(app), transaction.stagingPath) &&
    pathIsInside(getDesktopWebappInstallBackupRoot(app), transaction.backupPath);
}

function restoreFailedActivation(app: App, transaction: WebappInstallTransaction) {
  if (fs.existsSync(transaction.backupPath)) {
    removeIfExists(transaction.installPath);
    renameWithRetry(transaction.backupPath, transaction.installPath);
  } else if (transaction.phase === "activated") {
    removeIfExists(transaction.installPath);
  }
  removeIfExists(transaction.stagingPath);
  fs.rmSync(transactionPath(app, transaction.id), { force: true });
}

export function activateWebappInstall(options: {
  app: App;
  id: string;
  installPath: string;
  stagingPath: string;
}) {
  const backupRoot = getDesktopWebappInstallBackupRoot(options.app);
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `${options.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const transaction: WebappInstallTransaction = {
    schemaVersion: 1,
    id: options.id,
    phase: "prepared",
    hadExisting: fs.existsSync(options.installPath),
    installPath: options.installPath,
    stagingPath: options.stagingPath,
    backupPath,
    updatedAt: new Date().toISOString()
  };
  writeTransaction(options.app, transaction);

  try {
    if (fs.existsSync(options.installPath)) {
      renameWithRetry(options.installPath, backupPath);
    }
    transaction.phase = "backed-up";
    transaction.updatedAt = new Date().toISOString();
    writeTransaction(options.app, transaction);

    renameWithRetry(options.stagingPath, options.installPath);
    transaction.phase = "activated";
    transaction.updatedAt = new Date().toISOString();
    writeTransaction(options.app, transaction);
    return transaction;
  } catch (error) {
    try {
      restoreFailedActivation(options.app, transaction);
    } catch (restoreError) {
      console.warn("failed to restore WebApp after install activation error", options.id, restoreError);
    }
    throw error;
  }
}

export function commitWebappInstall(app: App, transaction: WebappInstallTransaction) {
  for (const targetPath of [transaction.backupPath, transaction.stagingPath]) {
    try {
      removeIfExists(targetPath);
    } catch (error) {
      console.warn("failed to clean committed WebApp install artifact", transaction.id, targetPath, error);
    }
  }
  try {
    fs.rmSync(transactionPath(app, transaction.id), { force: true });
  } catch (error) {
    console.warn("failed to remove committed WebApp install journal", transaction.id, error);
  }
}

export function rollbackWebappInstall(app: App, transaction: WebappInstallTransaction) {
  if (fs.existsSync(transaction.backupPath)) {
    removeIfExists(transaction.installPath);
    renameWithRetry(transaction.backupPath, transaction.installPath);
  } else if (!transaction.hadExisting) {
    removeIfExists(transaction.installPath);
  } else {
    throw new Error(`Cannot rollback WebApp ${transaction.id}: backup directory is missing.`);
  }
  removeIfExists(transaction.stagingPath);
  fs.rmSync(transactionPath(app, transaction.id), { force: true });
}

function readTransaction(filePath: string): WebappInstallTransaction | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WebappInstallTransaction>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.id !== "string" ||
      (value.phase !== "prepared" && value.phase !== "backed-up" && value.phase !== "activated") ||
      typeof value.installPath !== "string" ||
      typeof value.stagingPath !== "string" ||
      typeof value.backupPath !== "string"
    ) {
      return null;
    }
    return {
      ...value,
      hadExisting: value.hadExisting === true
    } as WebappInstallTransaction;
  } catch {
    return null;
  }
}

export function recoverWebappInstallTransactions(app: App) {
  const stateRoot = getDesktopWebappsStateRoot(app);
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  const recovered: string[] = [];
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const filePath = path.join(stateRoot, entry.name, TRANSACTION_FILE);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const transaction = readTransaction(filePath);
    if (
      !transaction ||
      transaction.id !== entry.name ||
      !isSafeTransaction(app, transaction)
    ) {
      fs.rmSync(filePath, { force: true });
      continue;
    }
    try {
      if (!fs.existsSync(transaction.installPath) && fs.existsSync(transaction.backupPath)) {
        renameWithRetry(transaction.backupPath, transaction.installPath);
      } else if (fs.existsSync(transaction.installPath)) {
        removeIfExists(transaction.backupPath);
      }
      removeIfExists(transaction.stagingPath);
      fs.rmSync(filePath, { force: true });
      recovered.push(transaction.id);
    } catch (error) {
      console.warn("failed to recover WebApp install transaction", transaction.id, error);
    }
  }
  return recovered;
}

export const __installTransactionTestInternals = {
  TRANSACTION_FILE,
  transactionPath
};
