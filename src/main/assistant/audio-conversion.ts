import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AUDIO_CONVERSION_TIMEOUT_MS = 60000;

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

function resolveExistingExecutable(candidates: string[]) {
  return candidates.find((candidate) => {
    if (candidate.includes(path.sep)) {
      return fs.existsSync(candidate);
    }
    return true;
  }) ?? "";
}

async function convertToWav(inputPath: string, outputPath: string) {
  const ffmpeg = resolveExistingExecutable([
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "ffmpeg"
  ]);
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
