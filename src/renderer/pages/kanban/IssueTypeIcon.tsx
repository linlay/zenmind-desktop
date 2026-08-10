import type { ComponentType } from "react";
import {
  ApartmentOutlined,
  BookFilled,
  BugFilled,
  BulbFilled,
  CheckSquareFilled,
  FileTextFilled,
  FlagFilled,
  ProfileFilled
} from "@ant-design/icons";

const ISSUE_TYPE_ICON_COMPONENTS: Record<string, ComponentType> = {
  bulb: BulbFilled,
  "book-open": BookFilled,
  book: BookFilled,
  "check-square": CheckSquareFilled,
  "list-tree": ProfileFilled,
  list: ProfileFilled,
  bug: BugFilled,
  file: FileTextFilled,
  flag: FlagFilled,
  hierarchy: ApartmentOutlined
};

const ISSUE_TYPE_COLOR_ALIASES: Record<string, string> = {
  blue: "#3b82f6",
  purple: "#8b5cf6",
  green: "#22c55e",
  cyan: "#06b6d4",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  gray: "#64748b",
  grey: "#64748b"
};

const ISSUE_TYPE_FALLBACKS: Record<string, { icon: string; color: string }> = {
  requirement: { icon: "bulb", color: ISSUE_TYPE_COLOR_ALIASES.blue },
  story: { icon: "book-open", color: ISSUE_TYPE_COLOR_ALIASES.purple },
  task: { icon: "check-square", color: ISSUE_TYPE_COLOR_ALIASES.green },
  subtask: { icon: "file", color: ISSUE_TYPE_COLOR_ALIASES.cyan },
  problem: { icon: "bug", color: ISSUE_TYPE_COLOR_ALIASES.red },
  bug: { icon: "bug", color: ISSUE_TYPE_COLOR_ALIASES.red }
};

function normalizeIssueTypeKey(value?: string | null) {
  return value?.trim().toLowerCase().replace(/[\s_-]+/gu, "") ?? "";
}

export function resolveIssueTypeColor(color?: string | null, issueTypeKey?: string | null) {
  const normalizedColor = color?.trim().toLowerCase() ?? "";
  if (/^#[0-9a-f]{6}$/u.test(normalizedColor)) {
    return normalizedColor;
  }
  const fallback = ISSUE_TYPE_FALLBACKS[normalizeIssueTypeKey(issueTypeKey)];
  return ISSUE_TYPE_COLOR_ALIASES[normalizedColor] ?? fallback?.color ?? ISSUE_TYPE_COLOR_ALIASES.gray;
}

export function IssueTypeIcon({
  icon,
  color,
  issueTypeKey,
  label,
  className = ""
}: {
  icon?: string | null;
  color?: string | null;
  issueTypeKey?: string | null;
  label?: string;
  className?: string;
}) {
  const fallback = ISSUE_TYPE_FALLBACKS[normalizeIssueTypeKey(issueTypeKey)];
  const Icon = ISSUE_TYPE_ICON_COMPONENTS[icon?.trim().toLowerCase() ?? ""]
    ?? ISSUE_TYPE_ICON_COMPONENTS[fallback?.icon ?? "file"]
    ?? FileTextFilled;
  return (
    <span
      className={`issue-type-icon ${className}`.trim()}
      style={{ color: resolveIssueTypeColor(color, issueTypeKey) }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    >
      <Icon />
    </span>
  );
}
