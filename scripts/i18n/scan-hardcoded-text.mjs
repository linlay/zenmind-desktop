import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(projectRoot, "src");
const strict = process.argv.includes("--strict");
const hanPattern = /[\p{Script=Han}]/u;

const allowedFiles = new Set([
  "src/shared/i18n/dictionaries/zhCN.ts",
  "src/shared/brand.ts",
  // Generated brand metadata and per-locale dictionary overrides, not UI source.
  "src/shared/generated/brand.ts"
]);

const allowedLinePatterns = [
  {
    file: "src/main/modules/web-surfaces/awcp/addons/forum-compose.ts",
    pattern: /textContent\?\.trim\(\) === 'Markdown 源码'|input\[placeholder\^="最多 5 个"\]/u,
    reason: "selectors match literal labels on the external Chinese website"
  },
  {
    file: "src/main/modules/web-surfaces/website-bridges/builtin.ts",
    pattern: /^\s*(?:compose\("(?:fill|publish)"|rule\.site =|if \(page\.path === "\/forum"\) rule\.site =)/u,
    reason: "versioned AI-facing AWCP manual for the Chinese forum"
  },
  {
    file: "src/main/modules/webs/webapps/lan-access.ts",
    pattern: /^\s*if \(platform === "win32"\) return \/.*\/iu\.test\(name\) \? 0 : 1;$/u,
    reason: "localized Windows network interface names used for matching"
  },
  {
    file: "src/renderer/pages/kanban/KanbanPage.tsx",
    pattern: /^\s*if \(\/.*\/u\.test\((?:normalized|granularStatusKey)\)\) (?:return [0-3];|\{)$/u,
    reason: "server status keywords used for classification, not display"
  },
  {
    file: "src/renderer/pages/kanban/stageColor.ts",
    pattern: /^\s*if \(\/.*\/u\.test\(semantic\)\) \{$/u,
    reason: "multilingual server stage keywords used for color classification"
  },
  {
    file: "src/main/modules/identity/identity-center-auth.ts",
    pattern: /找不到与参数名称/u,
    reason: "localized PowerShell stderr matcher"
  },
  {
    file: "src/main/modules/kanban/local-projects.ts",
    pattern: /replace\(\/\[\^\\p\{Script=Han\}a-z0-9\]\+/u,
    reason: "Chinese slug character range"
  },
  {
    file: "src/renderer/copilot/pet-copilot/DesktopPet.tsx",
    pattern: /DESKTOP_PET_REVIEW_TEXT_PATTERN/u,
    reason: "desktop pet review keyword matcher"
  }
];

const allowedBlocks = [
  {
    file: "src/main/modules/agent-platform/image-generation-events.ts",
    start: /^export const IMAGE_OPERATION_INSTRUCTIONS:/u,
    end: /^\};/u,
    reason: "fixed AI-facing image generation instructions, not UI messages"
  },
  {
    file: "src/main/modules/agent-platform/image-generation-events.ts",
    start: /^export function buildZenmiImageGenerateMessage\(/u,
    end: /^\}/u,
    reason: "fixed tool invocation prompt; UI errors below remain subject to scanning"
  },
  {
    file: "src/renderer/pages/kanban/KanbanPage.tsx",
    start: /^\s*const columnLabels = new Set\(\[/u,
    end: /^\s*\]\);/u,
    reason: "server status aliases used to suppress duplicate labels, not display"
  },
  {
    file: "src/main/modules/web-surfaces/awcp/addons/1024forum.ts",
    start: /^export const forum1024Rule:/u,
    end: /^\};/u,
    reason: "versioned AI-facing AWCP manual for the Chinese forum, not Desktop UI labels"
  },
  {
    file: "src/renderer/pages/functional-market/skillDiscovery.ts",
    start: /^const categoryAliases:/u,
    end: /^\};/u,
    reason: "server category aliases used for matching, not display labels"
  },
  {
    file: "src/shared/work-panel-review.ts",
    start: /^export function buildWorkPanelReviewComposerDraft/u,
    end: /^\}$/u,
    reason: "fixed AI-facing WorkPanel review draft protocol"
  },
  {
    file: "src/shared/desktop-pet.ts",
    start: /DESKTOP_PET_DONE_FALLBACK_TEXT|DESKTOP_PET_GENERIC_PREVIEW_TEXTS|DESKTOP_PET_STATUS_HINT_TEXTS/u,
    end: /\]\s+as const;|\]\);|DESKTOP_PET_DONE_FALLBACK_TEXT/u,
    reason: "desktop pet generic status matcher"
  },
  {
    file: "src/main/modules/pet/navigation-projection.ts",
    start: /DESKTOP_PET_GENERIC_TASK_PREVIEWS|DESKTOP_PET_DONE_PREVIEW_FALLBACK|DESKTOP_PET_GENERIC_DONE_PREVIEWS/u,
    end: /\]\);|DESKTOP_PET_DONE_PREVIEW_FALLBACK/u,
    reason: "desktop pet generic preview matcher"
  },
  {
    file: "src/main/modules/pet/preview-controller.ts",
    start: /DESKTOP_PET_GENERIC_TASK_PREVIEWS|DESKTOP_PET_DONE_PREVIEW_FALLBACK|DESKTOP_PET_GENERIC_DONE_PREVIEWS/u,
    end: /\]\);|DESKTOP_PET_DONE_PREVIEW_FALLBACK/u,
    reason: "desktop pet generic preview matcher"
  },
  {
    file: "src/main/modules/pet/desktop-pet-preview.ts",
    start: /DONE_FALLBACK_SUMMARY|GENERIC_DONE_SUMMARIES/u,
    end: /\]\);|DONE_FALLBACK_SUMMARY/u,
    reason: "desktop pet done-summary matcher"
  }
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(target);
    }
    return target;
  });
}

function stripComments(line, state) {
  let rest = line;
  let output = "";
  while (rest.length > 0) {
    if (state.inBlockComment) {
      const endIndex = rest.indexOf("*/");
      if (endIndex === -1) {
        return "";
      }
      state.inBlockComment = false;
      rest = rest.slice(endIndex + 2);
      continue;
    }

    const lineCommentIndex = rest.indexOf("//");
    const blockCommentIndex = rest.indexOf("/*");
    if (lineCommentIndex !== -1 && (blockCommentIndex === -1 || lineCommentIndex < blockCommentIndex)) {
      output += rest.slice(0, lineCommentIndex);
      return output;
    }
    if (blockCommentIndex !== -1) {
      output += rest.slice(0, blockCommentIndex);
      rest = rest.slice(blockCommentIndex + 2);
      state.inBlockComment = true;
      continue;
    }
    output += rest;
    break;
  }
  return output;
}

function allowedLineReason(relativePath, line) {
  const lineRule = allowedLinePatterns.find((rule) => rule.file === relativePath && rule.pattern.test(line));
  return lineRule?.reason ?? "";
}

function scanFile(filePath) {
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
  if (!/\.(ts|tsx)$/u.test(filePath) || allowedFiles.has(relativePath)) {
    return [];
  }

  const failures = [];
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/u);
  const commentState = { inBlockComment: false };
  let activeBlock = null;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const codeLine = stripComments(rawLine, commentState);
    const matchingBlock = activeBlock ??
      allowedBlocks.find((rule) => rule.file === relativePath && rule.start.test(codeLine));
    const blockReason = matchingBlock?.reason ?? "";
    if (matchingBlock) {
      activeBlock = matchingBlock;
    }

    if (hanPattern.test(codeLine) && !blockReason && !allowedLineReason(relativePath, codeLine)) {
      failures.push({
        path: relativePath,
        line: lineNumber,
        text: codeLine.trim()
      });
    }

    if (activeBlock?.end.test(codeLine)) {
      activeBlock = null;
    }
  });

  return failures;
}

const failures = walk(srcRoot).flatMap(scanFile);

if (failures.length > 0) {
  console.log("Hardcoded user-visible Han text remains:");
  for (const failure of failures) {
    console.log(`- ${failure.path}:${failure.line}: ${failure.text}`);
  }
  if (strict) {
    process.exitCode = 1;
  }
} else {
  console.log("No hardcoded user-visible Han text found outside i18n dictionaries.");
}
