// Only technical identifiers and measurements may cross the performance log boundary.
export function sanitizePerformanceEvent(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {};
  for (const key of ["stage", "surfaceId", "switchId", "instanceId", "completionScope"]) {
    const value = input[key];
    if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) output[key] = value;
  }
  for (const key of ["webContentsId", "transitionId", "previousTransitionId", "routeRevision",
    "documentGeneration", "hostMonoMs", "elapsedMs", "eventLoopDelayMs", "longTaskCount",
    "longTaskTotalMs", "longTaskMaxMs"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) output[key] = value;
  }
  for (const key of ["active", "fallbackIssued"]) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  return output;
}
