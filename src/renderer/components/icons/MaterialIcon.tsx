import type { CSSProperties } from "react";
import sprite from "./material-sprite.svg";
import { getMaterialIconSymbolId, type MaterialIconName } from "./materialRegistry";
export type { MaterialIconName } from "./materialRegistry";

/** Local sprite; both outlined and filled symbols inherit the current theme. */
export function MaterialIcon({ name, size = 16, className, style }: {
  name: MaterialIconName; size?: number; className?: string; style?: CSSProperties;
}) {
  return <svg width={size} height={size} className={className} aria-hidden="true" focusable="false"
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, fill: "currentColor", ...style }}>
    <use href={`${sprite}#${getMaterialIconSymbolId(name)}`} />
  </svg>;
}
