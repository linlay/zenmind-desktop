export type OpenAISSEParseResult = {
  buffer: string;
  deltas: string[];
  done: boolean;
};

function readDeltaFromPayload(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const firstChoice = choices[0] as { delta?: { content?: unknown } };
  return typeof firstChoice.delta?.content === "string" ? firstChoice.delta.content : "";
}

export function parseOpenAISSEChunk(buffer: string, chunk: string): OpenAISSEParseResult {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split(/\r?\n\r?\n/u);
  const nextBuffer = parts.pop() ?? "";
  const deltas: string[] = [];
  let done = false;

  for (const part of parts) {
    const data = part
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      done = true;
      continue;
    }

    try {
      const delta = readDeltaFromPayload(JSON.parse(data));
      if (delta) {
        deltas.push(delta);
      }
    } catch {
      // Ignore malformed provider frames and keep streaming subsequent frames.
    }
  }

  return {
    buffer: nextBuffer,
    deltas,
    done
  };
}
