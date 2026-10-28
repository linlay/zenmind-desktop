import type { DesktopArtifactFolder, DesktopArtifactIdentity, DesktopArtifactListInput, DesktopArtifactRecord } from "../../../shared/artifacts";
export type LibraryView = { kind: "all" | "recent" | "starred" | "unfiled" } | { kind: "folder"; id: string } | { kind: "tag"; tag: string };
export type LibraryLayout = "small" | "large" | "list";
export const LIBRARY_DRAG_TYPE = "application/x-zenmind-library-items";
export const artifactKey = (item: DesktopArtifactIdentity) => JSON.stringify([item.chatId, item.runId, item.artifactId]);
export const artifactIdentity = (item: DesktopArtifactIdentity): DesktopArtifactIdentity => ({ chatId: item.chatId, runId: item.runId, artifactId: item.artifactId });
export const artifactName = (item: DesktopArtifactRecord) => item.displayName || item.name;
export function artifactStatus(item: DesktopArtifactRecord) {
  if (item.sourceState !== "active") return item.sourceState;
  if (item.contentState !== "ready") return item.contentState;
  if (item.accessState === "denied" || item.accessState === "error") return item.accessState;
  return "ready";
}
export const artifactCanOpen = (item: DesktopArtifactRecord) => item.sourceState === "active" && !["unresolved", "ambiguous"].includes(item.contentState);
export function folderTrail(folders: DesktopArtifactFolder[], id: string | null): DesktopArtifactFolder[] {
  const path: DesktopArtifactFolder[] = [], seen = new Set<string>();
  while (id && !seen.has(id) && seen.size < 20) {
    seen.add(id);
    const folder = folders.find(item => item.id === id);
    if (!folder) break;
    path.unshift(folder); id = folder.parentId;
  }
  return path;
}
export function libraryScope(view: LibraryView): DesktopArtifactListInput {
  if (view.kind === "folder") return { folderId: view.id };
  if (view.kind === "unfiled") return { folderId: null };
  if (view.kind === "starred") return { favoritesOnly: true };
  if (view.kind === "recent") return { recent: true };
  if (view.kind === "tag") return { tag: view.tag };
  return {};
}
export function readLibraryLayout(): LibraryLayout {
  try { const value = localStorage.getItem("desktop.library.layout"); if (["small", "large", "list"].includes(value!)) return value as LibraryLayout; } catch { /* Presentation preferences are optional. */ }
  return "large";
}
export function readLibraryDrag(raw: string): DesktopArtifactIdentity[] {
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items) || !items.length || items.length > 100) return [];
    if (items.some(item => !item || [item.chatId, item.runId, item.artifactId].some(value => typeof value !== "string" || value.length > 256) || !item.chatId || !item.artifactId)) return [];
    return items.map(artifactIdentity);
  } catch { return []; }
}
export function formatArtifactSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
