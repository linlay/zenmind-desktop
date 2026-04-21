import { CUSTOM_SIDEBAR_ICONS } from "../../shared/custom-sidebar-icons";

type BrandMarkProps = {
  className?: string;
};

export type SidebarIllustrationKind =
  | "control"
  | "assistant"
  | "market"
  | "help"
  | "settings"
  | "service"
  | "futures"
  | "autumn"
  | "custom";

type SidebarIllustrationProps = {
  kind: SidebarIllustrationKind;
  className?: string;
};

const customSidebarIconDataUris = new Map<string, string>();

function getCustomSidebarIconDataUri(iconId: string) {
  const cached = customSidebarIconDataUris.get(iconId);
  if (cached) {
    return cached;
  }

  const icon = CUSTOM_SIDEBAR_ICONS.find((candidate) => candidate.id === iconId) ?? CUSTOM_SIDEBAR_ICONS[0];
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.svg)}`;
  customSidebarIconDataUris.set(iconId, dataUri);
  return dataUri;
}

function IconFrame({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}

function AssistantIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <path
        d="M64 48h96a32 32 0 0 1 32 32v64a32 32 0 0 1-32 32h-16l-32 32v-32h-48a32 32 0 0 1-32-32v-64a32 32 0 0 1 32-32z"
        fill="#93C5FD"
      />
      <path
        d="M96 80h96a32 32 0 0 1 32 32v64a32 32 0 0 1-32 32h-16l-32 32v-32h-48a32 32 0 0 1-32-32v-64a32 32 0 0 1 32-32z"
        fill="#3B82F6"
      />
      <circle cx="120" cy="144" r="12" fill="#FFFFFF" />
      <circle cx="160" cy="144" r="12" fill="#FFFFFF" />
      <circle cx="200" cy="144" r="12" fill="#FFFFFF" />
    </IconFrame>
  );
}

function ConsoleIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <rect x="24" y="56" width="208" height="152" rx="24" fill="#1E293B" />
      <path d="M24 80a24 24 0 0 1 24-24h160a24 24 0 0 1 24 24v24H24z" fill="#334155" />
      <circle cx="56" cy="68" r="6" fill="#EF4444" />
      <circle cx="76" cy="68" r="6" fill="#F59E0B" />
      <circle cx="96" cy="68" r="6" fill="#10B981" />
      <path
        d="M56 120l20 20-20 20"
        stroke="#10B981"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <rect x="88" y="148" width="24" height="8" rx="4" fill="#10B981" />
      <rect x="56" y="172" width="100" height="8" rx="4" fill="#475569" />
    </IconFrame>
  );
}

function ControlCenterIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <rect x="32" y="32" width="192" height="192" rx="40" fill="#C4B5FD" />
      <rect x="80" y="64" width="32" height="128" rx="16" fill="#8B5CF6" />
      <rect x="144" y="64" width="32" height="128" rx="16" fill="#8B5CF6" />
      <circle cx="96" cy="144" r="24" fill="#FFFFFF" />
      <circle cx="160" cy="96" r="24" fill="#FFFFFF" />
    </IconFrame>
  );
}

function MarketIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <path
        d="M120 128h40"
        stroke="#CBD5E1"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray="8 8"
        fill="none"
      />
      <rect x="48" y="80" width="96" height="96" rx="24" fill="#8B5CF6" />
      <path d="M80 128h32m-16-16v32" stroke="#FFFFFF" strokeWidth="8" strokeLinecap="round" />
      <rect x="160" y="80" width="48" height="48" rx="16" fill="#F472B6" />
      <circle cx="184" cy="104" r="8" fill="#FFFFFF" />
      <rect x="160" y="144" width="48" height="48" rx="16" fill="#FBBF24" />
      <rect x="172" y="164" width="24" height="8" rx="4" fill="#FFFFFF" />
    </IconFrame>
  );
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <circle cx="128" cy="128" r="96" fill="#FDA4AF" />
      <circle cx="128" cy="128" r="72" fill="#E11D48" />
      <path
        d="M104 104a24 24 0 0 1 48 0c0 16-24 20-24 36"
        stroke="#FFFFFF"
        strokeWidth="16"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="128" cy="168" r="10" fill="#FFFFFF" />
    </IconFrame>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <g fill="#818CF8">
        <circle cx="128" cy="128" r="80" />
        <rect x="104" y="24" width="48" height="208" rx="16" />
        <rect x="24" y="104" width="208" height="48" rx="16" />
        <rect x="104" y="24" width="48" height="208" rx="16" transform="rotate(45 128 128)" />
        <rect x="104" y="24" width="48" height="208" rx="16" transform="rotate(-45 128 128)" />
      </g>
      <circle cx="128" cy="128" r="56" fill="#4F46E5" />
      <circle cx="128" cy="128" r="24" fill="#FFFFFF" />
    </IconFrame>
  );
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <img
      src="./brand-icon.png"
      alt="品牌标识"
      className={className}
      style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 8 }}
      onError={(event) => {
        (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}

export function CustomSidebarIcon({ iconId, className }: { iconId: string; className?: string }) {
  return <img src={getCustomSidebarIconDataUri(iconId)} alt="" aria-hidden="true" className={className} />;
}

function FuturesIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <rect x="24" y="24" width="208" height="208" rx="40" fill="#1D4ED8" />
      <rect x="24" y="24" width="208" height="208" rx="40" fill="#FFFFFF" opacity="0.08" />
      <line x1="72" y1="70" x2="72" y2="190" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
      <rect x="60" y="100" width="24" height="56" rx="4" fill="#FFFFFF" />
      <line x1="128" y1="56" x2="128" y2="200" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
      <rect x="116" y="80" width="24" height="80" rx="4" fill="#34D399" />
      <line x1="184" y1="86" x2="184" y2="178" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
      <rect x="172" y="110" width="24" height="44" rx="4" fill="#F87171" />
    </IconFrame>
  );
}

function AutumnIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <rect x="24" y="24" width="208" height="208" rx="40" fill="#F97316" />
      <rect x="24" y="24" width="208" height="208" rx="40" fill="#FFFFFF" opacity="0.08" />
      <path
        d="M128 56c-40 20-64 54-64 92 0 24 16 44 40 52 4-20 14-38 30-52-10 18-14 36-14 52 26-4 48-22 58-46 12-28 6-62-14-94-8-14-24-14-36-4z"
        fill="#FFFFFF"
      />
      <path d="M128 96v104" stroke="#F97316" strokeWidth="6" strokeLinecap="round" />
    </IconFrame>
  );
}

function CustomWebIcon({ className }: { className?: string }) {
  return (
    <IconFrame className={className}>
      <rect x="28" y="44" width="200" height="168" rx="28" fill="#0EA5E9" />
      <path d="M28 78a28 28 0 0 1 28-28h144a28 28 0 0 1 28 28v28H28z" fill="#38BDF8" />
      <circle cx="64" cy="78" r="8" fill="#E0F2FE" />
      <circle cx="92" cy="78" r="8" fill="#E0F2FE" />
      <circle cx="120" cy="78" r="8" fill="#E0F2FE" />
      <path d="M72 144h112M72 172h72" stroke="#FFFFFF" strokeWidth="12" strokeLinecap="round" fill="none" />
      <path d="M164 132l24 24-24 24" stroke="#BAE6FD" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </IconFrame>
  );
}

export function SidebarIllustration({ kind, className }: SidebarIllustrationProps) {
  switch (kind) {
    case "assistant":
      return <AssistantIcon className={className} />;
    case "market":
      return <MarketIcon className={className} />;
    case "help":
      return <HelpIcon className={className} />;
    case "settings":
      return <SettingsIcon className={className} />;
    case "service":
      return <ConsoleIcon className={className} />;
    case "futures":
      return <FuturesIcon className={className} />;
    case "autumn":
      return <AutumnIcon className={className} />;
    case "custom":
      return <CustomWebIcon className={className} />;
    case "control":
    default:
      return <ControlCenterIcon className={className} />;
  }
}
