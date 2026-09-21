/** Plain-text excerpt only: never render message Markdown/HTML in a pet notification. */
export function formatDesktopPetMessagePreview(value: string): string {
  const withoutFences = value.replace(/^\s*```[^\n]*\n/gm, "").replace(/```/g, "");
  // Keep code identifiers and operators intact while removing prose formatting.
  return withoutFences.split(/(`+[^`]*`+)/g).map((part, index) => {
    if (index % 2 === 1) return part.replace(/^`+|`+$/g, "");
    return part
      .replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, "$1")
      .replace(/(^|\s)#{1,6}\s+/g, "$1")
      .replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
      .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, "$1");
  }).join("").replace(/\s+/g, " ").trim();
}
