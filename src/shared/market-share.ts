/** Marketplace-owned context. Protocol and content versions are independent. */
export const MARKET_SHARE_RECEIVER = "builtin.market";
export type MarketShareContext = {
  itemId: string;
  resourceType: "connector";
  resourceVersion: string;
  display: { name: string; description: string; author: string; tags: string[] };
};
export type MarketShareCreateInput = { itemId: string; resourceVersion: string };
export type MarketShareTarget = { intentId: string; shareId: string; context: MarketShareContext };
export type MarketShareDelivery = { activationId: string; instanceId: string; generation: string; target: MarketShareTarget };

export function readMarketShareContext(value: unknown): MarketShareContext | null {
  if (!object(value) || !keys(value, ["itemId", "resourceType", "resourceVersion", "display"]) ||
      typeof value.itemId !== "string" || value.itemId.trim() !== value.itemId ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.itemId) || value.itemId.includes("..") ||
      value.resourceType !== "connector" || !text(value.resourceVersion, 128, true) || value.resourceVersion.trim() !== value.resourceVersion || /\p{Cc}/u.test(value.resourceVersion) ||
      !object(value.display) || !keys(value.display, ["name", "description", "author", "tags"])) return null;
  const display = value.display;
  if (!text(display.name, 255, true) || !text(display.description, 16_000) || !text(display.author, 255) ||
      !Array.isArray(display.tags) || display.tags.length > 64 || display.tags.some(tag => !text(tag, 128, true))) return null;
  return { itemId: value.itemId, resourceType: "connector", resourceVersion: value.resourceVersion,
    display: { name: display.name, description: display.description, author: display.author, tags: [...display.tags] } };
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function keys(value: Record<string, unknown>, expected: string[]) { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)); }
function text(value: unknown, maximum: number, required = false): value is string {
  return typeof value === "string" && value.length <= maximum && (!required || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
