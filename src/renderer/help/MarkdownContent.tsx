import type { ReactNode } from "react";
import { Link } from "react-router-dom";

type MarkdownContentProps = {
  markdown: string;
};

type Block =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let codeLines: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  }

  function flushList() {
    if (list) {
      blocks.push({ type: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  }

  for (const line of lines) {
    if (codeLines) {
      if (/^```/u.test(line)) {
        blocks.push({ type: "code", text: codeLines.join("\n") });
        codeLines = null;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (/^```/u.test(line)) {
      flushParagraph();
      flushList();
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/u);
    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/u);
    const listMatch = orderedMatch ?? unorderedMatch;
    if (listMatch) {
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listMatch[1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (codeLines) {
    blocks.push({ type: "code", text: codeLines.join("\n") });
  }
  flushParagraph();
  flushList();
  return blocks;
}

function isInternalLink(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }

    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={nodes.length}>{renderInline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      if (linkMatch) {
        const label = linkMatch[1];
        const href = linkMatch[2];
        nodes.push(
          isInternalLink(href) ? (
            <Link key={nodes.length} className="help-inline-link" to={href}>
              {renderInline(label)}
            </Link>
          ) : (
            <a key={nodes.length} className="help-inline-link" href={href} target="_blank" rel="noreferrer">
              {renderInline(label)}
            </a>
          )
        );
      } else {
        nodes.push(token);
      }
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function MarkdownContent({ markdown }: MarkdownContentProps) {
  const blocks = parseBlocks(markdown);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return <p key={index}>{renderInline(block.text)}</p>;
        }
        if (block.type === "code") {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }

        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item)}</li>
            ))}
          </ListTag>
        );
      })}
    </>
  );
}
