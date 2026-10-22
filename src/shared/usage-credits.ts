/** Format micro-Credits without converting the amount to an imprecise JS number. */
export function formatMicrocredits(value: string, locale: string): string {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(absolute / 1_000_000n);
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";
  return `${amount < 0n ? "-" : ""}${whole}${fraction ? decimal + fraction : ""} Credits`;
}

export function usageLimitProgress(limit: {
  state?: string; resets_at: string; quota_microcredits: string; charged_microcredits: string;
  token_quota: number; tokens: number; request_quota: number; requests: number;
}, now = Date.now()) {
  const expired = limit.state === "idle" || limit.state === "expired" || (Number.isFinite(Date.parse(limit.resets_at)) && Date.parse(limit.resets_at) <= now);
  const ratio = (used: bigint, quota: bigint) => quota > 0n ? Number((used * 100n) / quota) : 0;
  const usedPercent = expired ? 0 : Math.min(100, Math.max(0,
    ratio(BigInt(limit.charged_microcredits), BigInt(limit.quota_microcredits)),
    ratio(BigInt(Math.trunc(limit.tokens)), BigInt(Math.trunc(limit.token_quota))),
    ratio(BigInt(Math.trunc(limit.requests)), BigInt(Math.trunc(limit.request_quota)))
  ));
  return { usedPercent, remainingPercent: 100 - usedPercent, pending: expired };
}
