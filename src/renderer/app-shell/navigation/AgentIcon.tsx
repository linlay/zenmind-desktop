import { useEffect, useState, type CSSProperties, type ImgHTMLAttributes } from "react";
import type { AssistantNavAgentIcon } from "../../../shared/contracts";

import atlasIcon from "../../assets/agent-icons/atlas.svg";
import canvasIcon from "../../assets/agent-icons/canvas.svg";
import chatIcon from "../../assets/agent-icons/chat.svg";
import chimeIcon from "../../assets/agent-icons/chime.svg";
import chronosIcon from "../../assets/agent-icons/chronos.svg";
import coderIcon from "../../assets/agent-icons/coder.svg";
import cortexIcon from "../../assets/agent-icons/cortex.svg";
import databaseIcon from "../../assets/agent-icons/database.svg";
import defaultIcon from "../../assets/agent-icons/default.svg";
import emitIcon from "../../assets/agent-icons/emit.svg";
import fastIcon from "../../assets/agent-icons/fast.svg";
import fluxIcon from "../../assets/agent-icons/flux.svg";
import focusIcon from "../../assets/agent-icons/focus.svg";
import folderIcon from "../../assets/agent-icons/folder.svg";
import horizonIcon from "../../assets/agent-icons/horizon.svg";
import ideIcon from "../../assets/agent-icons/ide.svg";
import identityIcon from "../../assets/agent-icons/identity.svg";
import libraryIcon from "../../assets/agent-icons/library.svg";
import lunaIcon from "../../assets/agent-icons/luna.svg";
import peaksIcon from "../../assets/agent-icons/peaks.svg";
import portalIcon from "../../assets/agent-icons/portal.svg";
import pulseIcon from "../../assets/agent-icons/pulse.svg";
import resonanceIcon from "../../assets/agent-icons/resonance.svg";
import sentinelIcon from "../../assets/agent-icons/sentinel.svg";
import solIcon from "../../assets/agent-icons/sol.svg";
import sparkIcon from "../../assets/agent-icons/spark.svg";
import spectrumIcon from "../../assets/agent-icons/spectrum.svg";
import statueIcon from "../../assets/agent-icons/statue.svg";
import stratusIcon from "../../assets/agent-icons/stratus.svg";
import terminalIcon from "../../assets/agent-icons/terminal.svg";
import waveIcon from "../../assets/agent-icons/wave.svg";

type AgentIconProps = {
  icon?: AssistantNavAgentIcon;
  className?: string;
  size?: number;
  type?: "agent" | "team";
};

export const AGENT_ICON_NAMES = [
  "folder",
  "chat",
  "wave",
  "focus",
  "library",
  "coder",
  "canvas",
  "ide",
  "fast",
  "peaks",
  "flux",
  "pulse",
  "spark",
  "horizon",
  "emit",
  "database",
  "stratus",
  "sentinel",
  "identity",
  "spectrum",
  "chime",
  "sol",
  "atlas",
  "chronos",
  "statue",
  "portal",
  "resonance",
  "luna",
  "cortex",
  "terminal",
] as const;

const IconMap: Record<(typeof AGENT_ICON_NAMES)[number], string> = {
  folder: folderIcon,
  chat: chatIcon,
  wave: waveIcon,
  focus: focusIcon,
  library: libraryIcon,
  coder: coderIcon,
  canvas: canvasIcon,
  ide: ideIcon,
  fast: fastIcon,
  peaks: peaksIcon,
  flux: fluxIcon,
  pulse: pulseIcon,
  spark: sparkIcon,
  horizon: horizonIcon,
  emit: emitIcon,
  database: databaseIcon,
  stratus: stratusIcon,
  sentinel: sentinelIcon,
  identity: identityIcon,
  spectrum: spectrumIcon,
  chime: chimeIcon,
  sol: solIcon,
  atlas: atlasIcon,
  chronos: chronosIcon,
  statue: statueIcon,
  portal: portalIcon,
  resonance: resonanceIcon,
  luna: lunaIcon,
  cortex: cortexIcon,
  terminal: terminalIcon,
};

function isImageIcon(value: string) {
  return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/iu.test(value.trim());
}

function readIconName(icon?: AssistantNavAgentIcon) {
  if (typeof icon === "object" && icon?.name) {
    return icon.name.trim().toLowerCase();
  }
  if (typeof icon === "string") {
    return icon.trim().toLowerCase();
  }
  return "";
}

function readIconColor(icon?: AssistantNavAgentIcon) {
  return typeof icon === "object" && icon?.color ? icon.color.trim() : "";
}

function renderImageIcon(
  src: string,
  className: string | undefined,
  size: number,
  onError?: ImgHTMLAttributes<HTMLImageElement>["onError"],
) {
  return (
    <img
      className={className}
      src={src}
      alt=""
      onError={onError}
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        objectFit: "cover",
      }}
    />
  );
}

export function AgentIcon({
  icon,
  className,
  size = 32,
  type = "agent",
}: AgentIconProps) {
  const imageSource = typeof icon === "string" && isImageIcon(icon) ? icon.trim() : "";
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageSource]);

  if (imageSource && !imageFailed) {
    return renderImageIcon(imageSource, className, size, () => setImageFailed(true));
  }

  if (type === "agent") {
    const name = readIconName(icon);
    return renderImageIcon(IconMap[name as keyof typeof IconMap] || defaultIcon, className, size);
  }

  const style: CSSProperties = {
    fontSize: size,
    color: readIconColor(icon) || "#94a3b8",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      focusable="false"
      aria-hidden="true"
      className={["desktop-agent-icon-avatar", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <path
        d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19c0-2.7 1.9-5 4-5s4 2.3 4 5H4Zm8 0c0-1.4-.4-2.7-1.1-3.8.8-.8 1.8-1.2 3.1-1.2 2.1 0 4 2.3 4 5h-6Z"
        fill="currentColor"
      />
    </svg>
  );
}
