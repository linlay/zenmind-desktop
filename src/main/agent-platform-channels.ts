import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface ChannelGateway {
  url: string;
  "jwt-token": string;
}

export interface ChannelEntry {
  name: string;
  type: string;
  "default-agent": string;
  agents: string | string[];
  gateway: ChannelGateway;
}

interface ChannelsYaml {
  channels: Record<string, ChannelEntry>;
}

const CHANNELS_FILENAME = "channels.yml";

function getChannelsFilePath(installDir: string) {
  return path.join(installDir, "configs", CHANNELS_FILENAME);
}

function ensureConfigsDir(installDir: string) {
  const configsDir = path.join(installDir, "configs");
  if (!fs.existsSync(configsDir)) {
    fs.mkdirSync(configsDir, { recursive: true });
  }
  return configsDir;
}

export function readChannelsYaml(installDir: string): Record<string, ChannelEntry> {
  const filePath = getChannelsFilePath(installDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = yaml.load(content) as ChannelsYaml | undefined;
    return parsed?.channels ?? {};
  } catch {
    return {};
  }
}

function hasComments(content: string): boolean {
  return content.includes("#");
}

export function upsertChannel(
  installDir: string,
  channelId: string,
  entry: ChannelEntry
): void {
  ensureConfigsDir(installDir);
  const filePath = getChannelsFilePath(installDir);
  const existing = readChannelsYaml(installDir);

  if (fs.existsSync(filePath)) {
    const rawContent = fs.readFileSync(filePath, "utf8");
    if (hasComments(rawContent)) {
      console.warn("[agent-platform-channels] channels.yml contains comments; desktop edits will overwrite them");
    }
  }

  existing[channelId] = entry;

  const yamlContent = yaml.dump({ channels: existing }, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });

  fs.writeFileSync(filePath, yamlContent, "utf8");
}

export function removeChannel(installDir: string, channelId: string): void {
  const filePath = getChannelsFilePath(installDir);
  if (!fs.existsSync(filePath)) {
    return;
  }

  const existing = readChannelsYaml(installDir);
  if (!(channelId in existing)) {
    return;
  }

  delete existing[channelId];

  const yamlContent = yaml.dump({ channels: existing }, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });

  fs.writeFileSync(filePath, yamlContent, "utf8");
}

export function getChannelEntry(installDir: string, channelId: string): ChannelEntry | null {
  const channels = readChannelsYaml(installDir);
  return channels[channelId] ?? null;
}
