import type { AssistantFirstInstallBootstrapNavigationResult } from "../../../shared/contracts";

export type FirstInstallBootstrapNavigation = {
  consume(): AssistantFirstInstallBootstrapNavigationResult;
};

export function createFirstInstallBootstrapNavigation(
  isFirstDesktopInstall: boolean,
): FirstInstallBootstrapNavigation {
  let shouldOpen = isFirstDesktopInstall;

  return {
    consume() {
      const result = { shouldOpen };
      shouldOpen = false;
      return result;
    },
  };
}
