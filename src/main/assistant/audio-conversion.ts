import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUDIO_CONVERSION_TIMEOUT_MS = 60000;
const FFMPEG_INSTALLER_SCOPE = "@ffmpeg-installer";

class AudioConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioConversionError";
  }
}

function audioMimeTypeToExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4")) {
    return "m4a";
  }
  if (normalized.includes("mpeg")) {
    return "mp3";
  }
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function ffmpegBinaryName(platform = process.platform) {
  if (platform === "win32") {
    return "ffmpeg.exe";
  }
  return "ffmpeg";
}

function ffmpegInstallerRuntimePackage(platform = process.platform, arch = process.arch) {
  const key = `${platform}/${arch}`;
  switch (key) {
    case "darwin/arm64":
      return "darwin-arm64";
    case "darwin/x64":
      return "darwin-x64";
    case "linux/arm64":
      return "linux-arm64";
    case "linux/x64":
      return "linux-x64";
    case "win32/x64":
      return "win32-x64";
    default:
      return "";
  }
}

function existingExecutable(candidate: string) {
  const executablePath = candidate.replace(/\.asar(?=[/\\])/u, ".asar.unpacked");
  try {
    const stat = fs.statSync(executablePath);
    return stat.isFile() ? executablePath : "";
  } catch {
    return "";
  }
}

function addNodeModulesFfmpegCandidates(candidates: string[], rootDir: string, runtimePackage: string, binaryName: string) {
  let currentDir = path.resolve(rootDir);
  while (true) {
    candidates.push(
      path.join(currentDir, "node_modules", FFMPEG_INSTALLER_SCOPE, runtimePackage, binaryName)
    );

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
}

function addPathFfmpegCandidates(candidates: string[], binaryName: string) {
  for (const searchDir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!searchDir.trim()) {
      continue;
    }
    candidates.push(path.join(searchDir, binaryName));
  }
}

function resolveFfmpegExecutable() {
  const binaryName = ffmpegBinaryName();
  const runtimePackage = ffmpegInstallerRuntimePackage();
  const candidates: string[] = [];

  if (runtimePackage) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      candidates.push(
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          FFMPEG_INSTALLER_SCOPE,
          runtimePackage,
          binaryName
        )
      );
      candidates.push(
        path.join(resourcesPath, "app", "node_modules", FFMPEG_INSTALLER_SCOPE, runtimePackage, binaryName)
      );
    }

    addNodeModulesFfmpegCandidates(candidates, process.cwd(), runtimePackage, binaryName);
    addNodeModulesFfmpegCandidates(candidates, __dirname, runtimePackage, binaryName);
  }

  if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg"
    );
  } else if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA ?? "", "ffmpeg", "bin", binaryName),
      path.join(process.env.ProgramFiles ?? "", "ffmpeg", "bin", binaryName)
    );
  }
  addPathFfmpegCandidates(candidates, binaryName);

  for (const candidate of candidates) {
    const executable = existingExecutable(candidate);
    if (executable) {
      return executable;
    }
  }
  return "";
}

async function convertToWav(inputPath: string, outputPath: string) {
  const ffmpeg = resolveFfmpegExecutable();
  if (!ffmpeg) {
    throw new AudioConversionError("未找到 ffmpeg，无法转换录音格式。");
  }

  try {
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath
    ], {
      timeout: AUDIO_CONVERSION_TIMEOUT_MS
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AudioConversionError(`录音格式转换失败：${message}`);
  }
}

export async function convertAudioBufferToWavBuffer(audio: Buffer, mimeType: string) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zenmind-voice-convert-"));
  try {
    const inputPath = path.join(tempDir, `input.${audioMimeTypeToExtension(mimeType)}`);
    const wavPath = path.join(tempDir, "input.wav");
    await fs.promises.writeFile(inputPath, audio);
    await convertToWav(inputPath, wavPath);
    return await fs.promises.readFile(wavPath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const __testInternals = {
  ffmpegBinaryName,
  ffmpegInstallerRuntimePackage
};
