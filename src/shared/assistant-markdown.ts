export type AssistantMarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string };

export type AssistantMarkdownBlock =
  | { type: "paragraph"; children: AssistantMarkdownInline[] }
  | { type: "heading"; level: number; children: AssistantMarkdownInline[] }
  | { type: "list"; ordered: boolean; items: AssistantMarkdownInline[][] }
  | { type: "table"; header: AssistantMarkdownInline[][]; rows: AssistantMarkdownInline[][][] }
  | { type: "code"; language: string; text: string }
  | { type: "rule" };

function isBlank(line: string) {
  return line.trim().length === 0;
}

function isRule(line: string) {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line);
}

function isHeading(line: string) {
  return /^(#{1,4})\s+\S/u.test(line.trim());
}

function parseHeading(line: string) {
  const match = /^(#{1,4})\s+(.+)$/u.exec(line.trim());
  if (!match) {
    return null;
  }
  return {
    level: match[1].length,
    text: match[2].trim()
  };
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string | undefined) {
  if (!line) {
    return false;
  }
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, "")));
}

function isTableStart(lines: string[], index: number) {
  return lines[index]?.includes("|") && isTableDivider(lines[index + 1]);
}

function parseListMarker(line: string) {
  const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
  if (ordered) {
    return { ordered: true, text: ordered[1].trim() };
  }
  const unordered = /^\s*[-*+]\s+(.+)$/u.exec(line);
  if (unordered) {
    return { ordered: false, text: unordered[1].trim() };
  }
  return null;
}

function pushText(segments: AssistantMarkdownInline[], text: string) {
  if (!text) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

export function parseAssistantMarkdownInline(value: string): AssistantMarkdownInline[] {
  const segments: AssistantMarkdownInline[] = [];
  let index = 0;

  while (index < value.length) {
    const nextStrong = value.indexOf("**", index);
    const nextCode = value.indexOf("`", index);
    const candidates = [nextStrong, nextCode].filter((candidate) => candidate >= 0);
    const markerIndex = candidates.length ? Math.min(...candidates) : -1;

    if (markerIndex < 0) {
      pushText(segments, value.slice(index));
      break;
    }

    pushText(segments, value.slice(index, markerIndex));

    if (markerIndex === nextCode) {
      const endIndex = value.indexOf("`", markerIndex + 1);
      if (endIndex < 0) {
        pushText(segments, value.slice(markerIndex));
        break;
      }
      segments.push({ type: "code", text: value.slice(markerIndex + 1, endIndex) });
      index = endIndex + 1;
      continue;
    }

    const endIndex = value.indexOf("**", markerIndex + 2);
    if (endIndex < 0) {
      pushText(segments, value.slice(markerIndex));
      break;
    }
    segments.push({ type: "strong", text: value.slice(markerIndex + 2, endIndex) });
    index = endIndex + 2;
  }

  return segments;
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? "";
  return isBlank(line) ||
    line.trim().startsWith("```") ||
    isHeading(line) ||
    isRule(line) ||
    isTableStart(lines, index) ||
    Boolean(parseListMarker(line));
}

export function parseAssistantMarkdown(input: string): AssistantMarkdownBlock[] {
  const normalized = input.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: AssistantMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.trim().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, text: body.join("\n") });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading.level,
        children: parseAssistantMarkdownInline(heading.text)
      });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = splitTableRow(line).map(parseAssistantMarkdownInline);
      index += 2;
      const rows: AssistantMarkdownInline[][][] = [];
      while (index < lines.length && lines[index]?.includes("|") && !isBlank(lines[index] ?? "")) {
        rows.push(splitTableRow(lines[index] ?? "").map(parseAssistantMarkdownInline));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const listMarker = parseListMarker(line);
    if (listMarker) {
      const ordered = listMarker.ordered;
      const items: AssistantMarkdownInline[][] = [];
      while (index < lines.length) {
        const marker = parseListMarker(lines[index] ?? "");
        if (!marker || marker.ordered !== ordered) {
          break;
        }
        items.push(parseAssistantMarkdownInline(marker.text));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      children: parseAssistantMarkdownInline(paragraphLines.join("\n").trim())
    });
  }

  return blocks;
}
