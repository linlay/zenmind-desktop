import type { ComponentType } from "react";
import {
  AppstoreFilled,
  BookFilled,
  BugFilled,
  BulbFilled,
  CheckSquareFilled,
  ContactsFilled,
  CrownFilled,
  ExperimentFilled,
  FileTextFilled,
  FlagFilled,
  ProfileFilled,
  RocketFilled
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
  hierarchy: AppstoreFilled,
  rocket: RocketFilled,
  experiment: ExperimentFilled,
  contacts: ContactsFilled,
  crown: CrownFilled
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

const ISSUE_TYPE_FALLBACKS: Record<string, { icon: string }> = {
  requirement: { icon: "bulb" },
  epic: { icon: "crown" },
  story: { icon: "book-open" },
  task: { icon: "check-square" },
  subtask: { icon: "list-tree" },
  problem: { icon: "bug" },
  bug: { icon: "bug" },
  deployment: { icon: "rocket" },
  free: { icon: "flag" },
  research: { icon: "experiment" },
  visit: { icon: "contacts" }
};

function normalizeIssueTypeKey(value?: string | null) {
  return value?.trim().toLowerCase().replace(/[\s_-]+/gu, "") ?? "";
}

export function resolveIssueTypeColor(color?: string | null) {
  const normalizedColor = color?.trim().toLowerCase() ?? "";
  if (/^#[0-9a-f]{6}$/u.test(normalizedColor)) {
    return normalizedColor;
  }
  return ISSUE_TYPE_COLOR_ALIASES[normalizedColor] ?? ISSUE_TYPE_COLOR_ALIASES.gray;
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
      style={{ color: resolveIssueTypeColor(color) }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    >
      <Icon />
    </span>
  );
}
