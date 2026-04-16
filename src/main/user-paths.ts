import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";

const USER_PATHS_FILE_NAME = "user-paths.json";
const MANAGED_DATA_DIRS = ["services", "plugins", "credentials"] as const;

type ManagedDataDir = (typeof MANAGED_DATA_DIRS)[number];

type UserPathsState = {
  configPath: string;
  loaded: boolean;
  configured: boolean;
  dataRoot: string;
};

type UserPathsConfig = {
  dataRoot: string;
};

let state: UserPathsState | null = null;

function getDefaultDataRoot(app: App) {
  return path.resolve(app.getPath("userData"));
}

function getConfigPath(app: App) {
  return path.join(app.getPath("userData"), USER_PATHS_FILE_NAME);
}

function ensureState(app: App) {
  const configPath = getConfigPath(app);
  if (!state || state.configPath !== configPath) {
    state = {
      configPath,
      loaded: false,
      configured: false,
      dataRoot: getDefaultDataRoot(app)
    };
  }
  return state;
}

function normalizeDataRoot(targetPath: string) {
  return path.resolve(targetPath);
}

function readConfigFile(configPath: string): UserPathsConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<UserPathsConfig>;
    if (typeof parsed.dataRoot !== "string" || parsed.dataRoot.trim() === "") {
      return null;
    }
    return {
      dataRoot: normalizeDataRoot(parsed.dataRoot)
    };
  } catch (error) {
    console.warn(`failed to read ${configPath}`, error);
    return null;
  }
}

function ensureManagedDataDirs(dataRoot: string) {
  fs.mkdirSync(dataRoot, { recursive: true });
  for (const dirName of MANAGED_DATA_DIRS) {
    fs.mkdirSync(path.join(dataRoot, dirName), { recursive: true });
  }
}

function ensureWritableDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
  const probePath = path.join(targetPath, `.zenmind-write-test-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probePath, "ok", "utf8");
  fs.rmSync(probePath, { force: true });
}

function isNestedPath(parentPath: string, targetPath: string) {
  const relative = path.relative(parentPath, targetPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertNoMigrationConflicts(newRoot: string) {
  for (const dirName of MANAGED_DATA_DIRS) {
    const targetDir = path.join(newRoot, dirName);
    if (!fs.existsSync(targetDir)) {
      continue;
    }
    if (fs.readdirSync(targetDir).length > 0) {
      throw new Error(`目标目录已包含现有 ${dirName} 数据，请选择一个空目录。`);
    }
  }
}

export function loadUserPaths(app: App) {
  const nextState = ensureState(app);
  const config = readConfigFile(nextState.configPath);
  nextState.loaded = true;
  nextState.configured = config !== null;
  nextState.dataRoot = config?.dataRoot ?? getDefaultDataRoot(app);
  return {
    configured: nextState.configured,
    dataRoot: nextState.dataRoot
  };
}

function ensureLoaded(app: App) {
  const currentState = ensureState(app);
  if (!currentState.loaded) {
    loadUserPaths(app);
  }
  return currentState;
}

export function hasConfiguredDataRoot(app: App) {
  return ensureLoaded(app).configured;
}

export function getDataRoot(app: App) {
  return ensureLoaded(app).dataRoot;
}

export function saveDataRoot(app: App, newRoot: string) {
  const normalizedRoot = normalizeDataRoot(newRoot);
  ensureManagedDataDirs(normalizedRoot);

  const configPath = getConfigPath(app);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ dataRoot: normalizedRoot }, null, 2)}\n`,
    "utf8"
  );

  const currentState = ensureState(app);
  currentState.loaded = true;
  currentState.configured = true;
  currentState.dataRoot = normalizedRoot;
  return normalizedRoot;
}

export function getServicesRoot(app: App) {
  return path.join(getDataRoot(app), "services");
}

export function getPluginsRoot(app: App) {
  return path.join(getDataRoot(app), "plugins");
}

export function getCredentialsRoot(app: App) {
  return path.join(getDataRoot(app), "credentials");
}

export async function migrateDataRoot(app: App, oldRoot: string, newRoot: string) {
  const normalizedOldRoot = normalizeDataRoot(oldRoot);
  const normalizedNewRoot = normalizeDataRoot(newRoot);

  if (normalizedOldRoot === normalizedNewRoot) {
    ensureManagedDataDirs(normalizedNewRoot);
    return;
  }

  if (isNestedPath(normalizedOldRoot, normalizedNewRoot)) {
    throw new Error("新数据目录不能位于当前数据目录内部。");
  }
  if (isNestedPath(normalizedNewRoot, normalizedOldRoot)) {
    throw new Error("新数据目录不能是当前数据目录的上级目录。");
  }

  ensureWritableDirectory(normalizedNewRoot);
  assertNoMigrationConflicts(normalizedNewRoot);

  const stageRoot = fs.mkdtempSync(path.join(normalizedNewRoot, ".zenmind-migration-"));
  const finalizedDirs: ManagedDataDir[] = [];

  try {
    for (const dirName of MANAGED_DATA_DIRS) {
      const sourceDir = path.join(normalizedOldRoot, dirName);
      if (!fs.existsSync(sourceDir)) {
        continue;
      }
      fs.cpSync(sourceDir, path.join(stageRoot, dirName), { recursive: true });
    }

    for (const dirName of MANAGED_DATA_DIRS) {
      const stagedDir = path.join(stageRoot, dirName);
      const targetDir = path.join(normalizedNewRoot, dirName);
      if (!fs.existsSync(stagedDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        continue;
      }
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length === 0) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.renameSync(stagedDir, targetDir);
      finalizedDirs.push(dirName);
    }

    for (const dirName of MANAGED_DATA_DIRS) {
      const sourceDir = path.join(normalizedOldRoot, dirName);
      if (fs.existsSync(sourceDir)) {
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    }

    saveDataRoot(app, normalizedNewRoot);
  } catch (error) {
    for (const dirName of finalizedDirs) {
      fs.rmSync(path.join(normalizedNewRoot, dirName), { recursive: true, force: true });
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export const __testInternals = {
  MANAGED_DATA_DIRS,
  ensureWritableDirectory,
  getConfigPath,
  isNestedPath,
  resetState() {
    state = null;
  }
};
