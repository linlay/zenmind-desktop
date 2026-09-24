import type { MarketInstallOptions, SkillPackageAdoptionRequest } from "../../../shared/contracts/marketplace";

const digest = /^[a-f0-9]{64}$/;
const key = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only the explicit adoption proof crosses IPC; never accept internal installer options. */
export function normalizeMarketInstallOptions(input: unknown): MarketInstallOptions {
  const value = object(input).skillPackageAdoption;
  if (value === undefined) return {};
  const adoption = object(value), revisions = object(adoption.expectedRevisions);
  const entries = Object.entries(revisions);
  if (typeof adoption.archiveSha256 !== "string" || !digest.test(adoption.archiveSha256) || entries.length === 0 || entries.length > 512 ||
      entries.some(([id, revision]) => !key.test(id) || typeof revision !== "string" || !digest.test(revision))) {
    throw new Error("Invalid skill package adoption confirmation");
  }
  return { skillPackageAdoption: { archiveSha256: adoption.archiveSha256, expectedRevisions: Object.fromEntries(entries) as Record<string, string> } };
}

/** Decode only the Platform's structured conflict; ordinary failures remain errors. */
export function readSkillPackageAdoption(cause: unknown): SkillPackageAdoptionRequest | undefined {
  try {
    const response = object(JSON.parse(cause instanceof Error ? cause.message : String(cause)));
    const error = object(object(response.data).error);
    if (response.code !== 409 || error.code !== "skill_package_adoption_required") return undefined;
    const adoption = object(error.adoption);
    if (typeof adoption.archiveSha256 !== "string" || !digest.test(adoption.archiveSha256) || !Array.isArray(adoption.skills) || adoption.skills.length === 0 || adoption.skills.length > 512) return undefined;
    const skills = adoption.skills.map(item => object(item));
    if (skills.some(skill => typeof skill.id !== "string" || !key.test(skill.id) || typeof skill.revision !== "string" || !digest.test(skill.revision) || !Array.isArray(skill.changedPaths) || skill.changedPaths.some(path => typeof path !== "string"))) return undefined;
    if (new Set(skills.map(skill => skill.id)).size !== skills.length) return undefined;
    return { archiveSha256: adoption.archiveSha256, skills: skills.map(skill => ({id: skill.id as string, revision: skill.revision as string, changedPaths: skill.changedPaths as string[]})) };
  } catch { return undefined; }
}

// A dynamic package contains generatedAt. Keep the exact reviewed ZIP briefly
// instead of silently confirming a different download. One pending dialog only.
let pendingArchive: { scope: string; sha: string; bytes: Uint8Array; timer: ReturnType<typeof setTimeout> } | undefined;
export function clearSkillPackageAdoptionArchive() {
  if (pendingArchive) clearTimeout(pendingArchive.timer);
  pendingArchive = undefined;
}
export function retainSkillPackageAdoptionArchive(scope: string, sha: string, bytes: Uint8Array) {
  clearSkillPackageAdoptionArchive();
  const timer = setTimeout(clearSkillPackageAdoptionArchive, 10 * 60_000);
  timer.unref();
  pendingArchive = { scope, sha, bytes, timer };
}
export function getSkillPackageAdoptionArchive(scope: string, sha: string): Uint8Array | undefined {
  return pendingArchive?.scope === scope && pendingArchive.sha === sha ? pendingArchive.bytes : undefined;
}
