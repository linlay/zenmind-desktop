import {
  parseAssistantMarkdown,
  type AssistantMarkdownBlock,
  type AssistantMarkdownInline
} from "../../shared/assistant-markdown";

type AssistantMarkdownContentProps = {
  content: string;
  className?: string;
};

function renderInline(segments: AssistantMarkdownInline[], keyPrefix: string) {
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (segment.type) {
      case "strong":
        return <strong key={key}>{segment.text}</strong>;
      case "code":
        return <code key={key}>{segment.text}</code>;
      case "text":
      default:
        return segment.text;
    }
  });
}

function renderBlock(block: AssistantMarkdownBlock, index: number) {
  const key = `markdown-block-${index}`;
  switch (block.type) {
    case "heading":
      return block.level <= 2 ? (
        <h3 key={key}>{renderInline(block.children, key)}</h3>
      ) : (
        <h4 key={key}>{renderInline(block.children, key)}</h4>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag key={key}>
          {block.items.map((item, itemIndex) => (
            <li key={`${key}-item-${itemIndex}`}>{renderInline(item, `${key}-item-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div className="assistant-markdown-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={`${key}-head-${cellIndex}`}>{renderInline(cell, `${key}-head-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-${cellIndex}`}>
                      {renderInline(cell, `${key}-row-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={key} />;
    case "paragraph":
    default:
      return <p key={key}>{renderInline(block.children, key)}</p>;
  }
}

export function AssistantMarkdownContent({ content, className = "" }: AssistantMarkdownContentProps) {
  const blocks = parseAssistantMarkdown(content);
  return (
    <div className={["assistant-markdown", className].filter(Boolean).join(" ")}>
      {blocks.map(renderBlock)}
    </div>
  );
}
