import type { KanbanPriority } from "../../../shared/contracts";

type KanbanSeverity = "critical" | "high" | "medium" | "low";

const PATHS = {
  lightningOutline:
    "M426.667 1024c-25.6 0-46.934-21.333-46.934-46.933v-12.8l59.734-290.134h-204.8C217.6 674.133 204.8 665.6 192 652.8c-12.8-12.8-12.8-34.133-8.533-51.2L379.733 34.133C392.533 12.8 409.6 0 430.933 0h264.534c17.066 0 29.866 8.533 42.666 25.6 12.8 17.067 12.8 34.133 8.534 51.2L627.2 349.867h174.933c17.067 0 34.134 8.533 42.667 25.6 8.533 17.066 8.533 38.4 0 59.733L465.067 998.4c-4.267 17.067-25.6 25.6-38.4 25.6z",
  lightningSolid:
    "M426.667 1024c-25.6 0-46.934-21.333-46.934-46.933v-12.8l59.734-290.134h-204.8C217.6 674.133 204.8 665.6 192 652.8c-12.8-12.8-12.8-34.133-8.533-51.2L379.733 34.133C392.533 12.8 409.6 0 430.933 0h264.534c17.066 0 29.866 8.533 42.666 25.6 12.8 17.067 12.8 34.133 8.534 51.2L627.2 349.867h174.933c17.067 0 34.134 8.533 42.667 25.6 8.533 17.066 8.533 38.4 0 59.733L465.067 998.4c-4.267 17.067-25.6 25.6-38.4 25.6z",
  flagBanner:
    "M458 426.163c23.302 14.573 51.744 34.003 78.214 52.870c52.378 37.171 253.300 22.810 335.245 29.498s143.827 24.781 143.827 24.781L901.045 343.725s123.834-185.786 108.557-181.914c-15.136 3.802-92.365 5.632-142.842-8.589c-50.618-14.291-166.707-15.206-245.837-15.206c-58.573 0-130.029-50.406-162.835-76.384V3.712H290v897.152h168V426.163z",
  flagBase:
    "M525.476 704.768v63.168c90.048 16.064 152.208 50.432 152.208 90.304 0 55.296-119.328 100.096-266.4 100.096s-266.304-44.8-266.304-100.096c0-39.04 59.712-72.896 146.736-89.344v-63.36C150.356 727.552 48.98 787.776 48.98 858.24c0 89.472 162.144 161.984 362.256 161.984s362.256-72.512 362.256-161.984c0-71.424-103.968-132.096-248.016-153.472z"
};

const PRIORITY_CONFIG: Record<KanbanPriority, { color: string; clipY: number; clipH: number }> = {
  P0: { color: "#EF4444", clipY: 0, clipH: 1024 },
  P1: { color: "#F97316", clipY: 205, clipH: 819 },
  P2: { color: "#EAB308", clipY: 358, clipH: 666 },
  P3: { color: "#84CC16", clipY: 358, clipH: 666 }
};

const SEVERITY_CONFIG: Record<KanbanSeverity, { color: string; clipW: number }> = {
  low: { color: "#84CC16", clipW: 737 },
  medium: { color: "#EAB308", clipW: 737 },
  high: { color: "#F97316", clipW: 876 },
  critical: { color: "#EF4444", clipW: 1024 }
};

let idCounter = 0;

export function PriorityIcon({
  priority,
  width = 10,
  height = 10
}: {
  priority: KanbanPriority;
  width?: number;
  height?: number;
}) {
  const config = PRIORITY_CONFIG[priority];
  const clipId = `kanban-pi-clip-${++idCounter}`;

  return (
    <svg className="kanban-priority-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width={width} height={height} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y={config.clipY} width="1024" height={config.clipH} />
        </clipPath>
      </defs>
      <path d={PATHS.lightningOutline} fill={config.color} fillOpacity="0.15" />
      <g clipPath={`url(#${clipId})`}>
        <path d={PATHS.lightningSolid} fill={config.color} fillOpacity="0.85" />
      </g>
    </svg>
  );
}

export function ImportanceIcon({
  severity,
  width = 10,
  height = 10
}: {
  severity: KanbanSeverity;
  width?: number;
  height?: number;
}) {
  const config = SEVERITY_CONFIG[severity];
  const clipId = `kanban-ii-clip-${++idCounter}`;

  return (
    <svg className="kanban-severity-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width={width} height={height} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={config.clipW} height="1024" />
        </clipPath>
      </defs>
      <path d={PATHS.flagBase} className="kanban-severity-flag-base" />
      <path d={PATHS.flagBanner} fill={config.color} fillOpacity="0.15" />
      <g clipPath={`url(#${clipId})`}>
        <path d={PATHS.flagBanner} fill={config.color} fillOpacity="0.85" />
      </g>
    </svg>
  );
}
