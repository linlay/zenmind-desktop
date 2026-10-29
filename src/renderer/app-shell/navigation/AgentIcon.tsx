import { useEffect, useRef, useState } from "react";
import type { AssistantNavAgentIcon } from "../../../shared/contracts";
import { AgentDefaultPose } from "../../components/icons/AgentDefaultPose";
import { registerAgentPointer } from "../../components/icons/agentPointerRuntime";
import { supportsAgentPointer } from "../../components/icons/agentPointerModel";
import type { AgentIconName } from "../../components/icons/agentAppearance";
import styles from "../../components/icons/AgentCharacter.module.css";
import { resolveAgentIcon } from "../../components/icons/agentAppearance";
export { AGENT_ICON_NAMES } from "../../components/icons/agentAppearance";

type AgentIconProps = {
  icon?: AssistantNavAgentIcon;
  mode?: string;
  interactive?: boolean;
  className?: string;
  size?: number;
  type?: "agent" | "team";
};
function isImageIcon(value: string) {
  return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/iu.test(value.trim());
}

function DefaultAgentAvatar({ name, color, className, size, interactive }: {
  name: AgentIconName; color?: string; className?: string; size: number; interactive: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!interactive || !root.current || !supportsAgentPointer(name)) return;
    return registerAgentPointer(root.current, name);
  }, [name, interactive]);
  const variants = { general: "general", coder: "code", kbase: "knowledge", team: "team", executor: "executor", proxy: "agent" } as const;
  return <svg ref={root} viewBox="20 35 160 145" width={size} height={size} focusable="false" aria-hidden="true"
    data-agent-avatar="" data-agent-pointer-disabled={interactive ? undefined : "true"}
    data-agent-icon-name={name} className={[styles.avatar, className].filter(Boolean).join(" ")}
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, color, fill: "currentColor" }}>
    <ellipse data-agent-shadow="" className={styles.avatarShadow} cx="100" cy={name === "team" ? 172 : 162} rx="62" ry="14" fill="currentColor" />
    <g data-agent-motion="" className={styles.avatarMotion}><AgentDefaultPose key={name} variant={variants[name]} /></g>
  </svg>;
}

export function AgentIcon({ icon, mode, className, size = 32, type = "agent", interactive = true }: AgentIconProps) {
  const imageSource = typeof icon === "string" && isImageIcon(icon) ? icon.trim() : "";
  const [failedSource, setFailedSource] = useState("");
  useEffect(() => { setFailedSource(""); }, [imageSource]);
  const appearance = resolveAgentIcon(icon, mode || (type === "team" ? "TEAM" : undefined));
  const glyph = <DefaultAgentAvatar name={appearance.name} color={appearance.color} className={className} size={size} interactive={interactive} />;
  // Explicit images remain authoritative, including their failure fallback.
  if (imageSource) return failedSource === imageSource ? glyph : <img className={className} src={imageSource} alt=""
    onError={() => setFailedSource(imageSource)} style={{ width: size, height: size, borderRadius: 8, objectFit: "cover" }} />;
  // Agent identity is owned by its configuration, never by the active skin.
  return glyph;
}
