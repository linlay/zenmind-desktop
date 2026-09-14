/** Host-composed Input.click; coordinates are CSS viewport pixels on every OS. */
export type DesktopClickWait = {
  selector?: string;
  state: "visible" | "hidden" | "value" | "checked" | "url";
  value?: string;
  checked?: boolean;
};
export type DesktopClickParams = {
  selector?: string;
  x?: number;
  y?: number;
  waitFor?: DesktopClickWait;
  timeoutMs?: number;
};
export type DesktopClickResult = {
  status: "clicked" | "condition_met" | "timeout" | "canceled" | "failed" | "navigation";
  stage: string;
  action: { pressed: boolean; released: boolean; outcome: "not_started" | "complete" | "unknown" };
  conditionMatched: boolean | null;
  evidence?: Record<string, unknown>;
  error?: string;
  timingsMs: { locate: number; click: number; wait: number; total: number };
};
