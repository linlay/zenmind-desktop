// Installed identities are directory names, not necessarily tooling-generated IDs.
// Use the same portable path boundary on macOS and Windows, without normalizing IDs.
const RESERVED_DIRECTORY_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isInstalledWebappId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    !RESERVED_DIRECTORY_NAME.test(value) &&
    !RESERVED_OBJECT_KEYS.has(value);
}

export function assertInstalledWebappId(value: string) {
  if (!isInstalledWebappId(value)) {
    throw new Error("webapp id must be a safe local directory name.");
  }
  return value;
}
