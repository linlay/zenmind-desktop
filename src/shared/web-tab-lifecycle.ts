export type WebTabCloseTransition = {
  closingIndex: number;
  remainingTabIds: string[];
  activeTabId: string | null;
};

export function selectSurvivingTabId(
  previousTabIds: string[],
  survivingTabIds: string[],
  previousActiveTabId: string | null
) {
  if (previousActiveTabId && survivingTabIds.includes(previousActiveTabId)) {
    return previousActiveTabId;
  }
  const survivors = new Set(survivingTabIds);
  const activeIndex = previousActiveTabId ? previousTabIds.indexOf(previousActiveTabId) : -1;
  if (activeIndex >= 0) {
    for (let index = activeIndex - 1; index >= 0; index -= 1) {
      const candidate = previousTabIds[index];
      if (candidate && survivors.has(candidate)) {
        return candidate;
      }
    }
    for (let index = activeIndex + 1; index < previousTabIds.length; index += 1) {
      const candidate = previousTabIds[index];
      if (candidate && survivors.has(candidate)) {
        return candidate;
      }
    }
  }
  return survivingTabIds[0] ?? null;
}

export function closeWebTabFromOrder(
  tabIds: string[],
  activeTabId: string | null,
  closingTabId: string
): WebTabCloseTransition | null {
  const closingIndex = tabIds.indexOf(closingTabId);
  if (closingIndex === -1) {
    return null;
  }
  const remainingTabIds = tabIds.filter((tabId) => tabId !== closingTabId);
  return {
    closingIndex,
    remainingTabIds,
    activeTabId: selectSurvivingTabId(tabIds, remainingTabIds, activeTabId)
  };
}
