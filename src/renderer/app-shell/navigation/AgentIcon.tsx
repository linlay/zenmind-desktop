import { SkinVisual } from "../../appearance/SkinVisual";
import { useEffect, useState } from "react";
import type { AssistantNavAgentIcon } from "../../../shared/contracts";
import { AgentGlyph } from "../../components/icons/AgentGlyph";
import { resolveAgentIcon } from "../../components/icons/agentAppearance";
export { AGENT_ICON_NAMES } from "../../components/icons/agentAppearance";

type AgentIconProps = {
  icon?: AssistantNavAgentIcon;
  mode?: string;
  className?: string;
  size?: number;
  type?: "agent" | "team";
};
function isImageIcon(value: string) {
  return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/iu.test(value.trim());
}

export function AgentIcon({ icon, mode, className, size = 32, type = "agent" }: AgentIconProps) {
  const imageSource = typeof icon === "string" && isImageIcon(icon) ? icon.trim() : "";
  const [failedSource, setFailedSource] = useState("");
  useEffect(() => { setFailedSource(""); }, [imageSource]);
  const appearance = resolveAgentIcon(icon, mode || (type === "team" ? "TEAM" : undefined));
  const glyph = <svg viewBox="20 35 160 145" width={size} height={size} focusable="false" aria-hidden="true"
    data-agent-icon-name={appearance.name} className={className}
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, color: appearance.color, fill: "currentColor" }}>
    <AgentGlyph name={appearance.name} />
  </svg>;
  // Explicit images remain authoritative, including their failure fallback.
  if (imageSource) return failedSource === imageSource ? glyph : <img className={className} src={imageSource} alt=""
    onError={() => setFailedSource(imageSource)} style={{ width: size, height: size, borderRadius: 8, objectFit: "cover" }} />;
  const configuredName = (typeof icon === "string" ? icon : icon?.name)?.trim().toLowerCase();
  const fallbackSlot = appearance.name === "coder" || appearance.name === "kbase" ? appearance.name : "default";
  // Keep published skin slots (terminal/library/etc.) while replacing the default geometry.
  const fallback = <SkinVisual slot={`agent.${fallbackSlot}`} className={className} style={{ width: size, height: size }}>{glyph}</SkinVisual>;
  return configuredName && configuredName !== fallbackSlot
    ? <SkinVisual slot={`agent.${configuredName}`} className={className} style={{ width: size, height: size }}>{fallback}</SkinVisual>
    : fallback;
}
