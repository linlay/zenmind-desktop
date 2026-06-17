import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dictionariesRoot = path.join(projectRoot, "src", "shared", "i18n", "dictionaries");
const helpRoot = path.join(projectRoot, "help-content");

const allowedLatinTerms = [
  /ZenMind/g,
  /Docker Desktop/g,
  /Desktop/g,
  /Application Support/g,
  /Node\.js/g,
  /macOS/g,
  /MacBook/g,
  /Windows/g,
  /Linux/g,
  /Unix/g,
  /NSIS/g,
  /Docker/g,
  /Podman/g,
  /Electron/g,
  /React/g,
  /OAuth2/g,
  /OIDC/g,
  /IAM/g,
  /JWT/g,
  /JWK/g,
  /API/g,
  /URL/g,
  /HTTP/g,
  /HTTPS/g,
  /WebSocket/g,
  /SSO/g,
  /JSON/g,
  /YAML/g,
  /PID/g,
  /ID/g,
  /ACP/g,
  /CODER/g,
  /Cookie/g,
  /Google/g,
  /Kanban/g,
  /App/g,
  /Action/g,
  /Bridge/g,
  /Chat/g,
  /Copilot/g,
  /Skill/g,
  /Token/g,
  /Web/g,
  /MiniMax/g,
  /Explorer/g,
  /Finder/g,
  /Tunnel/g,
  /Hub/g,
  /Agent/g,
  /Container/g,
  /Base/g,
  /AGENT/g,
  /DESKTOP/g,
  /TOKEN/g,
  /DEVICE/g,
  /VERSION/g,
  /VM/g,
  /GET/g,
  /POST/g,
  /RS256/g,
  /AES/g,
  /RSA/g,
  /PDF/g,
  /ZIP/g,
  /UTF-8/g,
  /DevTools/g,
  /PowerShell/g,
  /CLI/g,
  /PATH/g,
  /stderr/g,
  /webview/g,
  /postMessage/g,
  /frontendMode/g,
  /dependency-missing/g,
  /agent-platform/g,
  /agent-webclient/g,
  /agent-container-hub/g,
  /zenmind-app-server/g,
  /provider-register/g,
  /npm/g,
  /npx/g,
  /EADDRINUSE/g,
  /EACCES/g,
  /ENOENT/g,
  /Cmd/g,
  /Ctrl/g,
  /Option/g,
  /Shift/g,
  /Esc/g,
  /AI/g,
  /arm64/g,
  /x64/g,
  /v\d+/g,
  /GB/g,
  /MB/g,
  /well-known/g,
  /\b(?:access|action|apikey|apiKey|assetFileName|audience|auth|authMode|backend|bridge|capability|chatId|clientId|clientSecret|code|cookie|cron|daemon|definition|device|endpoint|env|fetch|field|fields|frontend|grant|hello|hostname|http|https|id|issuer|jwk|jwks|jwt|key|kind|machine|manifest|message|patch|payload|podman|provider|providers|public|readyState|runId|runState|running|script|scripts|selector|server|service|socket|start|startRun|status|sub|targetPath|token|type|ui|uri|web|worker|workspace)\b/g
];

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function walkFiles(dir, predicate) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(target, predicate);
    }
    return predicate(target) ? [target] : [];
  });
}

function extractDictionaryEntries(filePath) {
  const source = readFile(filePath);
  const entries = [];
  const entryPattern = /^(\s*"([^"]+)":\s*)"((?:\\"|[^"])*)"/gm;
  let match;
  while ((match = entryPattern.exec(source))) {
    entries.push({
      context: `${path.relative(projectRoot, filePath)}:${match[2]}`,
      text: JSON.parse(`"${match[3]}"`)
    });
  }
  return entries;
}

function collectHelpIndexText(filePath) {
  const parsed = JSON.parse(readFile(filePath));
  const entries = [
    ["sidebarTitle", parsed.sidebarTitle],
    ["heroTitle", parsed.heroTitle],
    ["heroDescription", parsed.heroDescription]
  ];

  for (const [categoryIndex, category] of parsed.categories.entries()) {
    entries.push([`categories[${categoryIndex}].label`, category.label]);
    for (const [itemIndex, item] of category.items.entries()) {
      entries.push([`categories[${categoryIndex}].items[${itemIndex}].title`, item.title]);
    }
  }

  return entries
    .filter(([, text]) => typeof text === "string")
    .map(([key, text]) => ({
      context: `${path.relative(projectRoot, filePath)}:${key}`,
      text
    }));
}

function stripMarkdownCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

function stripNonProse(text) {
  return stripMarkdownCodeBlocks(text)
    .replace(/`[^`]*`/g, "")
    .replace(/\{\{[A-Za-z0-9_.-]+\}\}/g, "")
    .replace(/\{[A-Za-z0-9_.-]+\}/g, "")
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z][A-Za-z0-9]*)+\b/g, " ")
    .replace(/\b[A-Za-z_][A-Za-z0-9_.-]*=/g, " ")
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+\b/g, " ")
    .replace(/\b[A-Za-z]+[A-Z][A-Za-z0-9]*\b/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/(?:^|\s)[~./%A-Za-z0-9_-]+(?:[\\/][~./%A-Za-z0-9_-]+)+/g, " ")
    .replace(/\b[A-Za-z0-9_.-]+\.(?:zip|tar\.gz|skill|json|md|png|dmg|ps1|sh|example|com)\b/g, " ")
    .replace(/\.(?:zip|tar\.gz|skill|json|md|png|dmg|ps1|sh)\b/g, " ");
}

function removeAllowedLatinTerms(text) {
  return allowedLatinTerms.reduce((current, pattern) => current.replace(pattern, " "), text);
}

function findUnexpectedLatin(text) {
  const prose = removeAllowedLatinTerms(stripNonProse(text));
  return [...prose.matchAll(/[A-Za-z][A-Za-z0-9.+/-]*[A-Za-z0-9]/g)]
    .map((match) => match[0])
    .filter((word) => word.length > 1);
}

const failures = [];

function checkNoHan(entries, localeLabel) {
  for (const { context, text } of entries) {
    if (/[\p{Script=Han}]/u.test(text)) {
      failures.push(`${localeLabel} contains Han text: ${context} -> ${JSON.stringify(text)}`);
    }
  }
}

function checkChineseLatin(entries) {
  for (const { context, text } of entries) {
    const unexpected = findUnexpectedLatin(text);
    if (unexpected.length > 0) {
      failures.push(`zh-CN contains unclassified Latin text: ${context} -> ${unexpected.join(", ")} in ${JSON.stringify(text)}`);
    }
  }
}

const enEntries = [
  ...extractDictionaryEntries(path.join(dictionariesRoot, "enUS.ts")),
  ...collectHelpIndexText(path.join(helpRoot, "en-US", "index.json")),
  ...walkFiles(path.join(helpRoot, "en-US"), (filePath) => filePath.endsWith(".md")).map((filePath) => ({
    context: path.relative(projectRoot, filePath),
    text: stripMarkdownCodeBlocks(readFile(filePath))
  }))
];

const zhEntries = [
  ...extractDictionaryEntries(path.join(dictionariesRoot, "zhCN.ts")),
  ...collectHelpIndexText(path.join(helpRoot, "zh-CN", "index.json")),
  ...walkFiles(path.join(helpRoot, "zh-CN"), (filePath) => filePath.endsWith(".md")).map((filePath) => ({
    context: path.relative(projectRoot, filePath),
    text: readFile(filePath)
  }))
];

checkNoHan(enEntries, "en-US");
checkChineseLatin(zhEntries);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`validated localized language separation (${zhEntries.length} zh-CN entries, ${enEntries.length} en-US entries)`);
