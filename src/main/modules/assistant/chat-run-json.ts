/** Preserve every persisted JSON record for the requested run, in storage order. */
export function selectChatRunJson(jsonl: string, runId: string): string {
  if (!runId.trim()) throw new Error("runId is required");
  const records = jsonl.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const selected = records.filter((record) => record && record.runId === runId);
  if (!selected.length) throw new Error("Run records are unavailable");
  return JSON.stringify(selected, null, 2);
}
