export const STARTUP_PHASES = [
  "booting",
  "platform-preflight",
  "runtime-env",
  "runtime-env-ready",
  "desktop-state-ready",
  "shell-ready",
  "core-services-starting",
  "core-ready",
  "non-core-ready",
  "degraded"
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

const STARTUP_PHASE_RANK: Record<StartupPhase, number> = {
  booting: 0,
  "platform-preflight": 1,
  "runtime-env": 2,
  "runtime-env-ready": 3,
  "desktop-state-ready": 4,
  "shell-ready": 5,
  "core-services-starting": 6,
  "core-ready": 7,
  "non-core-ready": 8,
  degraded: 9
};

export function isStartupPhaseAtLeast(current: StartupPhase, minimum: StartupPhase) {
  return STARTUP_PHASE_RANK[current] >= STARTUP_PHASE_RANK[minimum];
}
