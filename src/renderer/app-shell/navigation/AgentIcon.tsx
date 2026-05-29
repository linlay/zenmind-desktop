import { useEffect, useState, type CSSProperties, type ImgHTMLAttributes, type SVGProps } from "react";
import type { AssistantNavAgentIcon } from "../../../shared/contracts";

type AgentIconProps = {
  icon?: AssistantNavAgentIcon;
  className?: string;
  size?: number;
  type?: "agent" | "team";
};

type BuiltinIconConfig = {
  gradient: [string, string];
  shape:
    | "diamond"
    | "pie"
    | "hex"
    | "wave"
    | "orbit"
    | "square"
    | "chevron"
    | "eye"
    | "arrow"
    | "grid"
    | "loop"
    | "chart"
    | "ring"
    | "prism"
    | "horizon"
    | "aura"
    | "node"
    | "echo"
    | "star"
    | "pillar";
};

const BUILTIN_ICON_CONFIGS: Record<string, BuiltinIconConfig> = {
  ledger: { gradient: ["#60A5FA", "#2563EB"], shape: "diamond" },
  equity: { gradient: ["#FCD34D", "#D97706"], shape: "pie" },
  vault: { gradient: ["#34D399", "#059669"], shape: "hex" },
  pulse: { gradient: ["#A78BFA", "#6D28D9"], shape: "wave" },
  nexus: { gradient: ["#22D3EE", "#0891B2"], shape: "orbit" },
  quantum: { gradient: ["#F472B6", "#DB2777"], shape: "square" },
  yield: { gradient: ["#2DD4BF", "#0D9488"], shape: "chevron" },
  oracle: { gradient: ["#818CF8", "#4338CA"], shape: "eye" },
  vertex: { gradient: ["#FB7185", "#E11D48"], shape: "arrow" },
  matrix: { gradient: ["#E879F9", "#C026D3"], shape: "grid" },
  flux: { gradient: ["#38BDF8", "#0284C7"], shape: "loop" },
  apex: { gradient: ["#FB923C", "#EA580C"], shape: "chart" },
  cipher: { gradient: ["#94A3B8", "#475569"], shape: "ring" },
  prism: { gradient: ["#C084FC", "#7E22CE"], shape: "prism" },
  horizon: { gradient: ["#A3E635", "#4D7C0F"], shape: "horizon" },
  aura: { gradient: ["#FBBF24", "#D97706"], shape: "aura" },
  node: { gradient: ["#818CF8", "#3730A3"], shape: "node" },
  echo: { gradient: ["#2DD4BF", "#0F766E"], shape: "echo" },
  nova: { gradient: ["#F87171", "#B91C1C"], shape: "star" },
  summit: { gradient: ["#FDE047", "#CA8A04"], shape: "pillar" },
};

export const AGENT_ICON_NAMES = Object.keys(BUILTIN_ICON_CONFIGS);

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

function BuiltinAgentIcon({
  className,
  config,
  size,
}: {
  className?: string;
  config: BuiltinIconConfig;
  size: number;
}) {
  const gradientId = `desktop-agent-icon-${config.shape}-${config.gradient[0].replace(/[^a-z0-9]/giu, "")}`;
  const commonStroke: SVGProps<
    | SVGPathElement
    | SVGCircleElement
    | SVGRectElement
    | SVGPolygonElement
    | SVGLineElement
    | SVGEllipseElement
  > = {
    stroke: `url(#${gradientId})`,
    strokeWidth: 2,
    fill: "none",
  };
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={config.gradient[0]} />
          <stop offset="100%" stopColor={config.gradient[1]} />
        </linearGradient>
      </defs>
      {renderBuiltinShape(config.shape, gradientId, commonStroke)}
    </svg>
  );
}

function renderBuiltinShape(
  shape: BuiltinIconConfig["shape"],
  gradientId: string,
  commonStroke: SVGProps<
    | SVGPathElement
    | SVGCircleElement
    | SVGRectElement
    | SVGPolygonElement
    | SVGLineElement
    | SVGEllipseElement
  >,
) {
  const fill = `url(#${gradientId})`;
  switch (shape) {
    case "diamond":
      return (
        <>
          <rect
            x="12"
            y="12"
            width="24"
            height="24"
            transform="rotate(45 24 24)"
            fill={fill}
            opacity="0.8"
          />
          <rect
            x="6"
            y="6"
            width="36"
            height="36"
            transform="rotate(45 24 24)"
            {...commonStroke}
            opacity="0.4"
          />
        </>
      );
    case "pie":
      return (
        <>
          <path
            d="M24 4 A 20 20 0 0 1 44 24 L 24 24 Z"
            fill={fill}
            opacity="0.9"
          />
          <path
            d="M44 24 A 20 20 0 1 1 24 4 L 24 24 Z"
            {...commonStroke}
            opacity="0.4"
          />
        </>
      );
    case "hex":
      return (
        <>
          <polygon
            points="24,4 41.3,14 41.3,34 24,44 6.7,34 6.7,14"
            {...commonStroke}
            opacity="0.4"
          />
          <polygon
            points="24,12 34.4,18 34.4,30 24,36 13.6,30 13.6,18"
            fill={fill}
            opacity="0.8"
          />
        </>
      );
    case "wave":
      return (
        <>
          <path
            d="M4 24 Q 14 4 24 24 T 44 24"
            {...commonStroke}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.4"
          />
          <path
            d="M4 32 Q 14 12 24 32 T 44 32"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.9"
          />
        </>
      );
    case "orbit":
      return (
        <>
          <ellipse
            cx="24"
            cy="24"
            rx="20"
            ry="6"
            transform="rotate(45 24 24)"
            {...commonStroke}
            opacity="0.5"
          />
          <ellipse
            cx="24"
            cy="24"
            rx="20"
            ry="6"
            transform="rotate(-45 24 24)"
            {...commonStroke}
            opacity="0.5"
          />
          <circle cx="24" cy="24" r="10" fill={fill} opacity="0.9" />
        </>
      );
    case "square":
      return (
        <>
          <rect
            x="8"
            y="8"
            width="32"
            height="32"
            {...commonStroke}
            opacity="0.3"
          />
          <rect
            x="16"
            y="16"
            width="16"
            height="16"
            fill={fill}
            opacity="0.8"
          />
        </>
      );
    case "chevron":
      return (
        <>
          <path
            d="M10 38 L 24 24 L 38 38"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.3"
          />
          <path
            d="M10 28 L 24 14 L 38 28"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.6"
          />
          <path d="M10 18 L 24 4 L 38 18" fill={fill} opacity="0.9" />
        </>
      );
    case "eye":
      return (
        <>
          <path
            d="M4 24 C 14 8 34 8 44 24 C 34 40 14 40 4 24 Z"
            {...commonStroke}
            opacity="0.4"
          />
          <circle cx="24" cy="24" r="10" fill={fill} opacity="0.8" />
        </>
      );
    case "arrow":
      return (
        <polygon points="24,4 44,40 24,32 4,40" fill={fill} opacity="0.8" />
      );
    case "grid":
      return (
        <>
          <path
            d="M8 36 L 16 12 L 40 12 L 32 36 Z"
            {...commonStroke}
            opacity="0.4"
          />
          <path
            d="M16 24 L 36 24 M 22 12 L 18 36 M 34 12 L 30 36"
            {...commonStroke}
            opacity="0.4"
          />
          <circle cx="26" cy="24" r="6" fill={fill} opacity="0.9" />
        </>
      );
    case "loop":
      return (
        <>
          <path
            d="M8 36 C 8 12 40 12 40 36"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.4"
          />
          <path
            d="M40 12 C 40 36 8 36 8 12"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.9"
          />
        </>
      );
    case "chart":
      return (
        <>
          <path
            d="M4 40 L 20 16 L 30 26 L 44 6 L 44 40 Z"
            fill={fill}
            opacity="0.3"
          />
          <path
            d="M4 40 L 20 16 L 30 26 L 44 6"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
        </>
      );
    case "ring":
      return (
        <>
          <circle
            cx="24"
            cy="24"
            r="20"
            {...commonStroke}
            strokeDasharray="10 6"
            opacity="0.4"
          />
          <path
            d="M24 16 A 8 8 0 1 1 16 24"
            {...commonStroke}
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.9"
          />
        </>
      );
    case "prism":
      return (
        <>
          <polygon
            points="24,4 40,12 40,36 24,44 8,36 8,12"
            {...commonStroke}
            opacity="0.4"
          />
          <polygon points="24,4 40,12 24,24 8,12" fill={fill} opacity="0.6" />
          <polygon points="40,12 24,24 24,44 40,36" fill={fill} opacity="0.9" />
        </>
      );
    case "horizon":
      return (
        <>
          <path
            d="M4 32 Q 24 20 44 32"
            {...commonStroke}
            strokeWidth="3"
            opacity="0.5"
          />
          <path
            d="M4 40 Q 24 28 44 40"
            {...commonStroke}
            strokeWidth="4"
            opacity="0.9"
          />
          <circle cx="24" cy="16" r="8" fill={fill} opacity="0.8" />
        </>
      );
    case "aura":
      return (
        <>
          <circle cx="18" cy="18" r="12" fill={fill} opacity="0.5" />
          <circle cx="30" cy="18" r="12" fill={fill} opacity="0.7" />
          <circle cx="24" cy="30" r="12" fill={fill} opacity="0.9" />
        </>
      );
    case "node":
      return (
        <>
          <path
            d="M24 24 L 24 8 M 24 24 L 38 32 M 24 24 L 10 32"
            {...commonStroke}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.5"
          />
          <circle cx="24" cy="24" r="8" fill={fill} opacity="0.9" />
        </>
      );
    case "echo":
      return (
        <>
          <circle cx="16" cy="24" r="12" fill={fill} opacity="0.8" />
          <circle cx="24" cy="24" r="16" {...commonStroke} opacity="0.5" />
          <circle cx="32" cy="24" r="20" {...commonStroke} opacity="0.2" />
        </>
      );
    case "star":
      return (
        <polygon
          points="24,2 28,18 44,24 28,30 24,46 20,30 4,24 20,18"
          fill={fill}
          opacity="0.8"
        />
      );
    case "pillar":
      return (
        <>
          <rect
            x="18"
            y="8"
            width="12"
            height="28"
            rx="2"
            fill={fill}
            opacity="0.9"
          />
          <path
            d="M10 40 Q 24 32 38 40"
            {...commonStroke}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.5"
          />
        </>
      );
    default:
      return <circle cx="24" cy="24" r="16" fill={fill} opacity="0.85" />;
  }
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
    const imageProps: ImgHTMLAttributes<HTMLImageElement> = {
      className,
      src: imageSource,
      alt: "",
      onError: () => setImageFailed(true),
      style: {
        width: size,
        height: size,
        borderRadius: 8,
        objectFit: "cover",
      },
    };
    return <img {...imageProps} />;
  }

  const name = readIconName(icon);
  const config = BUILTIN_ICON_CONFIGS[name];
  if (config) {
    return <BuiltinAgentIcon className={className} config={config} size={size} />;
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
      {type === "team" ? (
        <path
          d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19c0-2.7 1.9-5 4-5s4 2.3 4 5H4Zm8 0c0-1.4-.4-2.7-1.1-3.8.8-.8 1.8-1.2 3.1-1.2 2.1 0 4 2.3 4 5h-6Z"
          fill="currentColor"
        />
      ) : (
        <path
          d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6H5Z"
          fill="currentColor"
        />
      )}
    </svg>
  );
}
