import {
  AGENT_WEBCLIENT_APPEARANCE_COLOR_TOKENS,
  AGENT_WEBCLIENT_APPEARANCE_RADIUS_TOKENS,
  parseAgentWebclientAppearanceTokens,
  type AgentWebclientAppearanceSnapshot
} from "../../shared/contracts/agent-webclient-bridge";
import type { DesktopAppearanceSnapshot } from "./model";

export type WebclientAppearanceProjection = Omit<AgentWebclientAppearanceSnapshot, "revision">;

export function readWebclientAppearanceProjection(
  appearance: DesktopAppearanceSnapshot,
  hostBackground: boolean,
  root = document.documentElement
): WebclientAppearanceProjection {
  const style = getComputedStyle(root);
  const values: Record<string, string> = {};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (const key of AGENT_WEBCLIENT_APPEARANCE_COLOR_TOKENS) {
    const value = style.getPropertyValue(key).trim();
    if (!value) continue;
    const parsed = parseAgentWebclientAppearanceTokens({ [key]: value });
    if (parsed) values[key] = parsed[key]!;
    else if (context && CSS.supports("color", value)) {
      // Resolve CSS-owned color-mix expressions locally; the guest receives only
      // bounded RGBA values, never expressions or arbitrary custom properties.
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      values[key] = `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(4))})`;
    }
  }
  for (const key of [...AGENT_WEBCLIENT_APPEARANCE_RADIUS_TOKENS, "--control-disabled-opacity"] as const) {
    const value = style.getPropertyValue(key).trim();
    if (parseAgentWebclientAppearanceTokens({ [key]: value })) values[key] = value;
  }
  return {
    schemaVersion: 1, resolvedTheme: appearance.resolvedTheme,
    skinId: appearance.skin.id, tokens: parseAgentWebclientAppearanceTokens(values) ?? {},
    background: { mode: hostBackground ? "host" : "opaque" }
  };
}
