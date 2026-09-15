import { useState, type CSSProperties, type ReactNode } from "react";
import { useOptionalAppearance } from "./AppearanceProvider";
import { useI18n } from "../i18n/useI18n";
import type { SkinVisualSlot } from "../../shared/contracts/agent-webclient-bridge";
import "./visuals.css";

export function SkinVisual({ slot, children, className, style, label }: {
  slot: string; children: ReactNode; className?: string; style?: CSSProperties; label?: string;
}) {
  const appearance = useOptionalAppearance();
  const src = appearance?.skin.visuals?.[appearance.resolvedTheme]?.images[slot as SkinVisualSlot];
  const [failed, setFailed] = useState<string>();
  return src && failed !== src ? <img className={`skin-visual ${className ?? ""}`} style={style} src={src}
    alt={label ?? ""} aria-hidden={label ? undefined : true} draggable={false} onError={() => setFailed(src)} /> : <>{children}</>;
}

export function SkinHeading({ group, children }: { group: string; children: ReactNode }) {
  const { locale } = useI18n();
  const name = ({ pinned: "pinned", chats: "chats", assistants: "projects", webs: "websites" } as Record<string, string>)[group];
  if (!name) return <>{children}</>;
  return <span className="skin-heading"><SkinVisual slot={`heading.${name}.${locale}`} className="skin-heading-art"
    label={typeof children === "string" ? children : undefined}>{children}</SkinVisual></span>;
}
