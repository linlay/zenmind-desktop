import type { BrowserWindow } from "electron";
import type {
  DesktopPageContextSnapshot,
  DesktopActionRendererResponse,
  DesktopPetAgentOption,
  DesktopPetState
} from "../shared/contracts";
import type { AssistantNavigationStatusClient } from "./copilot/core/assistant-navigation-status-client";
import type {
  DesktopPetBoundAgentStatus,
  DesktopPetLocalStatus,
  readDesktopPetStoredState
} from "./copilot/pet-copilot/desktop-pet";

type DesktopPetSettingsState = ReturnType<typeof readDesktopPetStoredState>;

export interface MainAppState {
  mainWindow: BrowserWindow | null;
  desktopPetWindow: BrowserWindow | null;
  isHandlingQuit: boolean;
  shutdownCleanupPromise: Promise<void> | null;
  shutdownCleanupComplete: boolean;
  serviceMutationQueue: Promise<void>;
  mainWindowSidebarTranslucencyEnabled: boolean;
  currentPageSnapshot: DesktopPageContextSnapshot | null;
  desktopPetSettings: DesktopPetSettingsState;
  desktopPetLocalStatus: DesktopPetLocalStatus;
  desktopPetAgentStatus: DesktopPetBoundAgentStatus | null;
  desktopPetAgentOptions: DesktopPetAgentOption[];
  desktopPetState: DesktopPetState;
  desktopPetIdleResetTimer: ReturnType<typeof setTimeout> | null;
  assistantNavigationStatusClient: AssistantNavigationStatusClient | null;
  desktopPetPendingProgrammaticBoundsSignature: string | null;
  desktopPetProgrammaticBoundsGuardTimer: ReturnType<typeof setTimeout> | null;
  desktopPetMouseInteractive: boolean;
  desktopActionRendererRequests: Map<string, {
    resolve: (response: DesktopActionRendererResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  logStreamSubscriptions: Map<string, {
    webContentsId: number;
    cleanup: () => void;
  }>;
}

export function createMainAppState(initialState: Partial<MainAppState> = {}): MainAppState {
  return {
    mainWindow: initialState.mainWindow ?? null,
    desktopPetWindow: initialState.desktopPetWindow ?? null,
    isHandlingQuit: initialState.isHandlingQuit ?? false,
    shutdownCleanupPromise: initialState.shutdownCleanupPromise ?? null,
    shutdownCleanupComplete: initialState.shutdownCleanupComplete ?? false,
    serviceMutationQueue: initialState.serviceMutationQueue ?? Promise.resolve(),
    mainWindowSidebarTranslucencyEnabled: initialState.mainWindowSidebarTranslucencyEnabled ?? true,
    currentPageSnapshot: initialState.currentPageSnapshot ?? null,
    desktopPetSettings: initialState.desktopPetSettings as DesktopPetSettingsState,
    desktopPetLocalStatus: initialState.desktopPetLocalStatus as DesktopPetLocalStatus,
    desktopPetAgentStatus: initialState.desktopPetAgentStatus ?? null,
    desktopPetAgentOptions: initialState.desktopPetAgentOptions ?? [],
    desktopPetState: initialState.desktopPetState as DesktopPetState,
    desktopPetIdleResetTimer: initialState.desktopPetIdleResetTimer ?? null,
    assistantNavigationStatusClient: initialState.assistantNavigationStatusClient ?? null,
    desktopPetPendingProgrammaticBoundsSignature: initialState.desktopPetPendingProgrammaticBoundsSignature ?? null,
    desktopPetProgrammaticBoundsGuardTimer: initialState.desktopPetProgrammaticBoundsGuardTimer ?? null,
    desktopPetMouseInteractive: initialState.desktopPetMouseInteractive ?? true,
    desktopActionRendererRequests: initialState.desktopActionRendererRequests ?? new Map(),
    logStreamSubscriptions: initialState.logStreamSubscriptions ?? new Map()
  };
}
