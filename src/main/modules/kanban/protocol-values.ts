
export function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function nullableText(value: unknown) {
  const text = readText(value);
  return text ? text : null;
}

export function optionalText(value: unknown) {
  const text = readText(value);
  return text ? text : undefined;
}

export function readBoolean(value: unknown) {
  return value === true;
}

export function readStringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(readText).filter(Boolean))]
    : [];
}

export function readEffortSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const seconds = Math.trunc(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function readDueDate(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= maxDay ? value.trim() : null;
}
