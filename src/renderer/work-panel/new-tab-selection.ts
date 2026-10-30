export type WorkPanelNewTabSelections = Record<string, { id: string; anchor: string | null }>;

export function isWorkPanelNewTabActive(
  selection: WorkPanelNewTabSelections[string] | undefined,
  activeItemId: string | null,
) {
  return Boolean(selection && selection.anchor === activeItemId);
}

export function resolveWorkPanelActiveItemId(
  workspace: { ownerChatId: string; activeItemId: string | null } | undefined,
  selections: WorkPanelNewTabSelections,
): string | null {
  if (!workspace || isWorkPanelNewTabActive(selections[workspace.ownerChatId], workspace.activeItemId)) return null;
  return workspace.activeItemId;
}
