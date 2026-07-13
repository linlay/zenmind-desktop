import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { App } from "electron";
import type {
  WebappEntry,
  WebappPublishInfo,
  WebappPublishInfoResult,
  WebappPublishInput,
  WebappPublishMode,
  WebappPublishResult,
  WebappPublishState
} from "../../../shared/contracts";
import { getDesktopWebappStateRoot } from "../../user-paths";
import { getWebappDir, readWebappItems } from "./store";

const PUBLISH_PROFILE_FILE = "webapp.publish.json";
const PUBLISH_STATE_FILE = "publish.json";
const DEFAULT_ENVIRONMENT = "production";
const DEFAULT_EXPIRATION_MS = 6 * 60 * 60 * 1_000;
const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;

type PublishProfile = {
  schemaVersion: 1;
  provider: "liteploy";
  mode: WebappPublishMode;
  port: number;
  stateMount: string | null;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type PublishContext = {
  item: WebappEntry;
  root: string;
  profile: PublishProfile;
};

const EMPTY_INFO: WebappPublishInfo = {
  configured: false,
  cliAvailable: false,
  mode: null,
  port: null,
  stateMount: null,
  persistentVolumeSupported: false,
  authorizedProjects: [],
  defaultProject: "",
  domainSuffix: ""
};

function nowIso() {
  return new Date().toISOString();
}

function redact(value: unknown) {
  return String(value || "")
    .replace(/^token:\s*.*$/gimu, "token: ***")
    .replace(/(--token(?:=|\s+))\S+/giu, "$1***")
    .replace(/\beyJ[A-Za-z0-9_-]{40,}\b/gu, "***")
    .replace(/((?:api[-_ ]?key|authorization)\s*[:=]\s*)\S+/giu, "$1***");
}

function errorMessage(error: unknown) {
  return redact(error instanceof Error ? error.message : String(error));
}

function readJson(filePath: string, label: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function findWebapp(app: App, id: string) {
  const normalizedId = id.trim();
  return readWebappItems(app).find((item) => item.id === normalizedId) ?? null;
}

function readPublishContext(app: App, id: string): PublishContext {
  const item = findWebapp(app, id);
  if (!item) {
    throw new Error("WebApp was not found.");
  }
  const root = item.installPath || getWebappDir(app, item.id);
  const profilePath = path.join(root, PUBLISH_PROFILE_FILE);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`${PUBLISH_PROFILE_FILE} is missing.`);
  }
  const raw = readJson(profilePath, PUBLISH_PROFILE_FILE);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${PUBLISH_PROFILE_FILE} must contain an object.`);
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.provider !== "liteploy") {
    throw new Error(`${PUBLISH_PROFILE_FILE} must use schemaVersion 1 and provider liteploy.`);
  }

  let profile: PublishProfile;
  if (value.mode === "static" && value.port === 80 && value.stateMount === null) {
    profile = {
      schemaVersion: 1,
      provider: "liteploy",
      mode: "static",
      port: 80,
      stateMount: null
    };
  } else if (value.mode === "fullstack" && value.port === 3000 && value.stateMount === "/data") {
    const dockerfile = path.join(root, "deploy", "Dockerfile");
    if (!fs.existsSync(dockerfile) || !fs.statSync(dockerfile).isFile()) {
      throw new Error("Full-stack publishing requires deploy/Dockerfile.");
    }
    profile = {
      schemaVersion: 1,
      provider: "liteploy",
      mode: "fullstack",
      port: 3000,
      stateMount: "/data"
    };
  } else {
    throw new Error(`${PUBLISH_PROFILE_FILE} must declare a supported static or fullstack profile.`);
  }
  return { item, root, profile };
}

function executableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? ["liteploy.exe", "liteploy.cmd", "liteploy"]
    : ["liteploy"];
}

function liteployCandidates(app: App, platform: NodeJS.Platform = process.platform) {
  const home = app.getPath("home");
  const directories: string[] = [];
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    directories.push(
      path.join(home, ".local", "bin"),
      path.join(localAppData, "Programs", "liteploy"),
      path.join(localAppData, "liteploy")
    );
  } else {
    directories.push(
      path.join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin"
    );
  }
  directories.push(...String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  if (process.env.LITEPLOY_HOME) {
    directories.push(path.resolve(process.env.LITEPLOY_HOME));
  }
  const candidates = directories.flatMap((directory) =>
    executableNames(platform).map((name) => path.join(directory, name))
  );
  return [...new Set(candidates)];
}

function resolveLiteploy(app: App, platform: NodeJS.Platform = process.platform) {
  for (const candidate of liteployCandidates(app, platform)) {
    try {
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit candidate.
    }
  }
  return "";
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current: string, chunk: Buffer) => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next, "utf8") > COMMAND_OUTPUT_LIMIT) {
        child.kill();
        throw new Error("Liteploy command output exceeded the safety limit.");
      }
      return next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        stdout = append(stdout, chunk);
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderr = append(stderr, chunk);
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.on("error", (error) => finish(() => reject(new Error(`Failed to start Liteploy: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      const output = {
        stdout: redact(stdout).trim(),
        stderr: redact(stderr).trim()
      };
      if (code !== 0) {
        reject(new Error([
          `Liteploy exited with code ${code ?? "unknown"}.`,
          output.stderr,
          output.stdout
        ].filter(Boolean).join("\n")));
        return;
      }
      resolve(output);
    }));

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Liteploy command timed out.")));
    }, options.timeoutMs ?? 30_000);
  });
}

function parseAuthorizedProjects(output: string) {
  const projects: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^([^\s]+)\s+[0-9.]+\s+CPU\s+\d+MB$/u);
    if (match) {
      projects.push(match[1]);
    }
  }
  return [...new Set(projects)].sort();
}

function parseDomainSuffix(output: string) {
  const match = output.match(/^domainSuffix:\s*(\S+)\s*$/mu);
  return match && /^\.[a-z0-9.-]+$/u.test(match[1]) ? match[1].toLowerCase() : "";
}

function stableName(value: string, maximum: number) {
  if (value.length <= maximum) {
    return value;
  }
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  const prefix = value.slice(0, maximum - digest.length - 1).replace(/-+$/u, "");
  return `${prefix}-${digest}`;
}

function stableApplicationName(project: string, webappId: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(project)) {
    throw new Error(`Project ${JSON.stringify(project)} cannot be used to generate a public domain.`);
  }
  const maximum = 63 - project.length - 1;
  if (maximum < 10) {
    throw new Error(`Project ${JSON.stringify(project)} is too long to generate a WebApp domain.`);
  }
  return stableName(webappId, maximum);
}

function validateEnvironment(value: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)) {
    throw new Error("Environment must be a lowercase DNS-style label.");
  }
  return value;
}

function validateExpiration(value: string | undefined) {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("Expiration must be a future RFC3339 timestamp.");
  }
  return new Date(timestamp).toISOString();
}

function publishStatePath(app: App, id: string) {
  return path.join(getDesktopWebappStateRoot(app, id), PUBLISH_STATE_FILE);
}

function writePublishState(app: App, state: WebappPublishState) {
  const filePath = publishStatePath(app, state.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function readPublishState(app: App, id: string): WebappPublishState | null {
  try {
    const value = readJson(publishStatePath(app, id), PUBLISH_STATE_FILE) as Partial<WebappPublishState>;
    if (!value || value.id !== id) {
      return null;
    }
    return {
      id,
      status: value.status === "publishing" || value.status === "published" || value.status === "error"
        ? value.status
        : "ready",
      mode: value.mode === "static" || value.mode === "fullstack" ? value.mode : null,
      project: typeof value.project === "string" ? value.project : "",
      environment: typeof value.environment === "string" ? value.environment : "",
      application: typeof value.application === "string" ? value.application : "",
      url: typeof value.url === "string" ? value.url : "",
      expiresAt: typeof value.expiresAt === "string" ? normalizeExpirationValue(value.expiresAt) : "",
      message: typeof value.message === "string" ? value.message : "",
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso()
    };
  } catch {
    return null;
  }
}

async function inspectPublishInfo(app: App, context: PublishContext | null, liteploy: string) {
  const info: WebappPublishInfo = {
    ...EMPTY_INFO,
    configured: Boolean(context),
    cliAvailable: Boolean(liteploy),
    mode: context?.profile.mode ?? null,
    port: context?.profile.port ?? null,
    stateMount: context?.profile.stateMount ?? null
  };
  if (!liteploy) {
    return info;
  }
  const [configShow, authProjects, deployHelp] = await Promise.all([
    runCommand(liteploy, ["config", "show"]),
    runCommand(liteploy, ["auth", "projects"]),
    runCommand(liteploy, ["app", "deploy", "--help"])
  ]);
  info.authorizedProjects = parseAuthorizedProjects(authProjects.stdout);
  info.defaultProject = info.authorizedProjects.length === 1 ? info.authorizedProjects[0] : "";
  info.domainSuffix = parseDomainSuffix(configShow.stdout);
  info.persistentVolumeSupported = /(^|\s)--volume(?:\s|$)/mu.test(`${deployHelp.stdout}\n${deployHelp.stderr}`);
  return info;
}

export async function getWebappPublishInfo(app: App, id: string): Promise<WebappPublishInfoResult> {
  const state = readPublishState(app, id.trim());
  let context: PublishContext | null = null;
  let contextError = "";
  try {
    context = readPublishContext(app, id);
  } catch (error) {
    contextError = errorMessage(error);
  }
  const liteploy = resolveLiteploy(app);
  try {
    const info = await inspectPublishInfo(app, context, liteploy);
    const ok = Boolean(context) && Boolean(liteploy) && info.authorizedProjects.length > 0 && Boolean(info.domainSuffix);
    const message = contextError || (!liteploy
      ? "Liteploy CLI was not found."
      : info.authorizedProjects.length === 0
        ? "No Liteploy project is authorized."
        : info.domainSuffix
          ? "Ready to publish."
          : "Liteploy did not return a domain suffix.");
    return { ok, info, state, message };
  } catch (error) {
    return {
      ok: false,
      info: {
        ...EMPTY_INFO,
        configured: Boolean(context),
        cliAvailable: Boolean(liteploy),
        mode: context?.profile.mode ?? null,
        port: context?.profile.port ?? null,
        stateMount: context?.profile.stateMount ?? null
      },
      state,
      message: contextError || errorMessage(error)
    };
  }
}

function deploymentArguments(
  context: PublishContext,
  project: string,
  environment: string,
  application: string,
  expiresAt: string,
  volumeSupported: boolean
) {
  const args = [
    "app", "deploy",
    "--project", project,
    "--env", environment,
    "--app", application
  ];
  if (context.profile.mode === "static") {
    args.push(
      "--path", path.resolve(context.root, context.item.frontend.root),
      "--build", "static",
      "--resources", "tiny",
      "--publish-dir", "."
    );
    if (context.item.frontend.spa !== false) {
      args.push("--spa");
    }
  } else {
    if (context.profile.stateMount && !volumeSupported) {
      throw new Error("The installed Liteploy CLI does not support --volume; full-stack data persistence cannot be guaranteed.");
    }
    args.push(
      "--path", context.root,
      "--build", "dockerfile",
      "--resources", "small",
      "--dockerfile", "deploy/Dockerfile",
      "--context", "."
    );
    if (context.profile.stateMount) {
      const volumeName = stableName(`${project}-${application}-data`, 63);
      args.push("--volume", `${volumeName}:${context.profile.stateMount}`);
    }
  }
  if (expiresAt) {
    args.push("--expires-at", expiresAt);
  }
  return args;
}

function domainArguments(project: string, environment: string, application: string, port: number) {
  return [
    "domain", "set",
    "--project", project,
    "--env", environment,
    "--app", application,
    "--port", String(port)
  ];
}

function statusArguments(project: string, environment: string, application: string) {
  return ["app", "status", "--project", project, "--env", environment, "--app", application];
}

function statusValue(output: string, field: string) {
  const match = output.match(new RegExp(`^${field}:\\s*(.+)$`, "mu"));
  return match ? match[1].trim() : "";
}

function normalizeExpirationValue(value: string) {
  const match = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/u);
  return match ? match[0] : value;
}

async function verifyUrl(url: string, requireHealthPayload = false) {
  let lastError = "verification failed";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "desktop-webapp-publisher/1" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (requireHealthPayload) {
        const payload = await response.json() as { ok?: unknown };
        if (payload?.ok !== true) {
          throw new Error("health response did not contain ok=true");
        }
      }
      return;
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < 11) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(`Public URL verification failed: ${lastError}`);
}

function createState(
  context: PublishContext,
  values: Partial<Omit<WebappPublishState, "id" | "mode" | "updatedAt">>
): WebappPublishState {
  return {
    id: context.item.id,
    status: values.status ?? "ready",
    mode: context.profile.mode,
    project: values.project ?? "",
    environment: values.environment ?? DEFAULT_ENVIRONMENT,
    application: values.application ?? "",
    url: values.url ?? "",
    expiresAt: values.expiresAt ?? "",
    message: values.message ?? "",
    updatedAt: nowIso()
  };
}

export async function publishWebapp(app: App, id: string, input: WebappPublishInput = {}): Promise<WebappPublishResult> {
  let context: PublishContext;
  try {
    context = readPublishContext(app, id);
  } catch (error) {
    const fallbackState: WebappPublishState = {
      id: id.trim(),
      status: "error",
      mode: null,
      project: "",
      environment: DEFAULT_ENVIRONMENT,
      application: "",
      url: "",
      expiresAt: "",
      message: errorMessage(error),
      updatedAt: nowIso()
    };
    return { ok: false, info: { ...EMPTY_INFO }, state: fallbackState, message: fallbackState.message };
  }

  const liteploy = resolveLiteploy(app);
  let info: WebappPublishInfo = {
    ...EMPTY_INFO,
    configured: true,
    cliAvailable: Boolean(liteploy),
    mode: context.profile.mode,
    port: context.profile.port,
    stateMount: context.profile.stateMount
  };
  let state = createState(context, { status: "error" });
  try {
    if (!liteploy) {
      throw new Error("Liteploy CLI was not found.");
    }
    info = await inspectPublishInfo(app, context, liteploy);
    await runCommand(liteploy, ["config", "test"], { timeoutMs: 30_000 });
    await runCommand(liteploy, ["project", "list"], { timeoutMs: 30_000 });

    const requestedProject = String(input.project || info.defaultProject).trim();
    if (!requestedProject) {
      throw new Error(`Choose one authorized project: ${info.authorizedProjects.join(", ")}`);
    }
    if (!info.authorizedProjects.includes(requestedProject)) {
      throw new Error(`Project ${JSON.stringify(requestedProject)} is not authorized.`);
    }
    if (!info.domainSuffix) {
      throw new Error("Liteploy did not return a valid domain suffix.");
    }
    const environment = validateEnvironment(String(input.environment || DEFAULT_ENVIRONMENT).trim());
    const expiresAt = validateExpiration(input.expiresAt);
    const application = stableApplicationName(requestedProject, context.item.id);
    const host = `${requestedProject}-${application}${info.domainSuffix}`.toLowerCase();
    const url = `https://${host}`;
    const plannedExpiration = expiresAt || new Date(Date.now() + DEFAULT_EXPIRATION_MS).toISOString();
    const deployArgs = deploymentArguments(
      context,
      requestedProject,
      environment,
      application,
      expiresAt,
      info.persistentVolumeSupported
    );
    const domainArgs = domainArguments(requestedProject, environment, application, context.profile.port);

    await runCommand(liteploy, ["--dry-run", ...deployArgs], { cwd: context.root, timeoutMs: 120_000 });
    await runCommand(liteploy, ["--dry-run", ...domainArgs], { cwd: context.root, timeoutMs: 60_000 });

    state = createState(context, {
      status: "publishing",
      project: requestedProject,
      environment,
      application,
      url,
      expiresAt: plannedExpiration,
      message: "Publishing with Liteploy..."
    });
    writePublishState(app, state);

    await runCommand(liteploy, deployArgs, { cwd: context.root, timeoutMs: 12 * 60_000 });
    await runCommand(liteploy, domainArgs, { cwd: context.root, timeoutMs: 120_000 });
    const status = await runCommand(
      liteploy,
      statusArguments(requestedProject, environment, application),
      { cwd: context.root, timeoutMs: 60_000 }
    );
    await verifyUrl(url);
    if (context.profile.mode === "fullstack") {
      await verifyUrl(`${url}${context.item.backend.healthPath}`, true);
    }

    state = createState(context, {
      status: "published",
      project: requestedProject,
      environment,
      application,
      url,
      expiresAt: normalizeExpirationValue(statusValue(status.stdout, "Expires") || plannedExpiration),
      message: statusValue(status.stdout, "Status") || "Published and verified."
    });
    writePublishState(app, state);
    return { ok: true, info, state, message: "WebApp published successfully." };
  } catch (error) {
    state = {
      ...state,
      status: "error",
      message: errorMessage(error),
      updatedAt: nowIso()
    };
    writePublishState(app, state);
    return { ok: false, info, state, message: state.message };
  }
}

export const __testInternals = {
  parseAuthorizedProjects,
  parseDomainSuffix,
  stableApplicationName,
  validateExpiration,
  validateEnvironment,
  readPublishState,
  resolveLiteploy
};
