type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#2663EB" />
      <path
        d="M7 7h10v2.4L11.2 15.6H17V18H7v-2.4L12.8 9.4H7z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

type SidebarIllustrationProps = {
  kind: "control" | "assistant" | "market" | "help" | "settings" | "service";
  className?: string;
};

export function SidebarIllustration({ kind, className }: SidebarIllustrationProps) {
  switch (kind) {
    case "assistant":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" fill="#93C5FD" />
          <rect x="7" y="8" width="10" height="6" rx="1.5" fill="#60A5FA" />
          <circle cx="10" cy="11" r="1.2" fill="#3B82F6" />
          <circle cx="14" cy="11" r="1.2" fill="#3B82F6" />
          <path d="M19 1l1 2.5 2.5 1-2.5 1L19 8l-1-2.5L15.5 4.5l2.5-1L19 1z" fill="#F59E0B" />
        </svg>
      );
    case "market":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <rect x="4" y="6" width="16" height="15" rx="2" fill="#F0ABFC" />
          <path d="M3 6h18v4H3z" fill="#E879F9" />
          <path d="M10 2h4v4h-4z" fill="#D946EF" />
          <path d="M12 11l1 2.5 2.5.5-2 1.5.5 2.5-2-1.5-2 1.5.5-2.5-2-1.5 2.5-.5z" fill="#FBBF24" />
        </svg>
      );
    case "help":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <rect x="5" y="4" width="15" height="16" rx="2" fill="#FDA4AF" />
          <path d="M5 4h4v16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#FB7185" />
          <path d="M13 9c0-1 1.5-1 1.5 0 0 1-1.5 1.5-1.5 2.5" stroke="#E11D48" strokeWidth="2" strokeLinecap="round" fill="none" />
          <circle cx="13" cy="14.5" r="1.2" fill="#E11D48" />
          <path d="M16 4v6l-1.5-1-1.5 1V4h3z" fill="#3B82F6" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" fill="#D1D5DB" />
          <circle cx="12" cy="12" r="6" fill="#9CA3AF" />
          <circle cx="12" cy="12" r="3" fill="#6B7280" />
          <circle cx="12" cy="6.5" r="1.5" fill="#3B82F6" />
        </svg>
      );
    case "service":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <rect x="2" y="3" width="20" height="18" rx="2.5" fill="#A5B4FC" />
          <rect x="2" y="3" width="6" height="18" rx="2.5" fill="#818CF8" />
          <rect x="9" y="3" width="13" height="5" rx="1.5" fill="#6366F1" />
          <rect x="9" y="10" width="13" height="11" rx="1.5" fill="#818CF8" />
          <circle cx="5" cy="6" r="1.5" fill="#F43F5E" />
        </svg>
      );
    case "control":
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#C4B5FD" />
          <rect x="7" y="6" width="3" height="12" rx="1.5" fill="#A78BFA" />
          <rect x="14" y="6" width="3" height="12" rx="1.5" fill="#A78BFA" />
          <rect x="5" y="13" width="7" height="4" rx="1.5" fill="#8B5CF6" />
          <rect x="12" y="7" width="7" height="4" rx="1.5" fill="#8B5CF6" />
          <circle cx="15.5" cy="9" r="1" fill="#10B981" />
        </svg>
      );
  }
}
