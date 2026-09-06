import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(projectRoot, "src");
const strict = process.argv.includes("--strict");
const hanPattern = /[\p{Script=Han}]/u;

const allowedFiles = new Set([
  "src/shared/i18n/dictionaries/zhCN.ts",
  "src/shared/brand.ts"
]);

const allowedLinePatterns = [
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
    file: "src/main/modules/pet/controller.part-1.ts",
    start: /DESKTOP_PET_GENERIC_TASK_PREVIEWS|DESKTOP_PET_DONE_PREVIEW_FALLBACK|DESKTOP_PET_GENERIC_DONE_PREVIEWS/u,
    end: /\]\);|DESKTOP_PET_DONE_PREVIEW_FALLBACK/u,
    reason: "desktop pet generic preview matcher"
  },
  {
    file: "src/main/modules/pet/controller.part-2.ts",
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
  const relativePath = path.relative(projectRoot, filePath);
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
