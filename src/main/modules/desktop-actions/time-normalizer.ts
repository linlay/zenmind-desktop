import type { DesktopActionOutputSchema } from "../../../shared/desktop-actions";

const EPOCH_MILLIS_MIN = 1_000_000_000_000;
const EPOCH_MILLIS_MAX = Number.MAX_SAFE_INTEGER;

export class ActionBridgeTimeContractError extends Error {
  readonly field: string;
  readonly location: string;

  constructor(field: string, location: string, reason: string) {
    super(reason);
    this.name = "ActionBridgeTimeContractError";
    this.field = field;
    this.location = location;
  }
}

function isEpochMillis(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= EPOCH_MILLIS_MIN &&
    value <= EPOCH_MILLIS_MAX;
}

type ParsedRfc3339 = {
  epochMillis: number;
  millisecondPrecise: boolean;
};

function parseRfc3339(value: unknown): ParsedRfc3339 | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const maxDay = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    month < 1 || month > 12 || day < 1 || day > maxDay ||
    hour > 23 || minute > 59 || second > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
  ) return undefined;
  const epoch = Date.parse(text);
  if (!Number.isSafeInteger(epoch)) return undefined;
  return {
    epochMillis: epoch,
    millisecondPrecise: fraction.length <= 3 || /^0*$/u.test(fraction.slice(3))
  };
}

function parseRfc3339EpochMillis(value: unknown) {
  const parsed = parseRfc3339(value);
  if (!parsed || !parsed.millisecondPrecise || !isEpochMillis(parsed.epochMillis)) return undefined;
  return parsed.epochMillis;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaRecord(value: unknown): DesktopActionOutputSchema | undefined {
  return isPlainObject(value) ? value : undefined;
}

function schemaText(schema: DesktopActionOutputSchema, key: string) {
  const value = schema[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function schemaMatches(value: unknown, schema: DesktopActionOutputSchema) {
  const expectedType = schemaText(schema, "type");
  if (expectedType === "object" && !isPlainObject(value)) return false;
  if (expectedType === "array" && !Array.isArray(value)) return false;
  if (expectedType === "string" && typeof value !== "string") return false;
  if (!isPlainObject(value)) return true;
  const properties = schemaRecord(schema.properties);
  if (!properties) return true;
  for (const [key, rawSchema] of Object.entries(properties)) {
    const propertySchema = schemaRecord(rawSchema);
    if (!propertySchema || !("const" in propertySchema)) continue;
    if (value[key] !== propertySchema.const) return false;
  }
  return true;
}

function adaptNode(value: unknown, schema: DesktopActionOutputSchema, location: string, field = "result", parent?: Record<string, unknown>): unknown {
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  for (const candidate of alternatives) {
    const candidateSchema = schemaRecord(candidate);
    if (candidateSchema && schemaMatches(value, candidateSchema)) {
      return adaptNode(value, candidateSchema, location, field, parent);
    }
  }

  const timeKind = schemaText(schema, "x-platform-time");
  if (timeKind) {
    if (timeKind !== "epoch-ms") throw new ActionBridgeTimeContractError(field, location, "unsupported x-platform-time declaration");
    if (isEpochMillis(value)) return value;
    const converted = parseRfc3339EpochMillis(value);
    if (converted !== undefined) return converted;
    throw new ActionBridgeTimeContractError(field, location, "must be epoch milliseconds or RFC3339");
  }
  if (schemaText(schema, "format") === "date-time" && parseRfc3339(value) === undefined) {
    throw new ActionBridgeTimeContractError(field, location, "must be RFC3339/RFC3339Nano with timezone");
  }

  if (Array.isArray(value)) {
    const itemSchema = schemaRecord(schema.items);
    return itemSchema
      ? value.map((item, index) => adaptNode(item, itemSchema, `${location}[${index}]`, field))
      : value;
  }
  if (!isPlainObject(value)) return value;

  const properties = schemaRecord(schema.properties);
  if (!properties) return value;
  const adapted: Record<string, unknown> = { ...value };
  for (const [key, rawSchema] of Object.entries(properties)) {
    const propertySchema = schemaRecord(rawSchema);
    if (!propertySchema || !(key in adapted)) continue;
    adapted[key] = adaptNode(adapted[key], propertySchema, `${location}.${key}`, key, adapted);
  }
  for (const [key, rawSchema] of Object.entries(properties)) {
    const propertySchema = schemaRecord(rawSchema);
    const pair = propertySchema && schemaText(propertySchema, "x-platform-time-pair");
    if (!pair || !(key in adapted)) continue;
    const readable = parseRfc3339EpochMillis(adapted[key]);
    const point = adapted[pair];
    if (readable === undefined || !isEpochMillis(point) || readable !== point) {
      throw new ActionBridgeTimeContractError(key, `${location}.${key}`, `must represent the same instant as ${pair}`);
    }
  }
  return adapted;
}

// Adapts only result fields explicitly declared by an action output schema.
// Unlisted fields are preserved verbatim, even when their names resemble
// platform lifecycle fields.
export function normalizeActionBridgeTimePayload(value: unknown, schema?: DesktopActionOutputSchema, location = "desktop.action.result"): unknown {
  return schema ? adaptNode(value, schema, location) : value;
}
