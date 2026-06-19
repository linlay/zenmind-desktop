import type { BrowserWindow } from "electron";
import type {
  DesktopPageContextSnapshot,
  DesktopActionRendererResponse,
  DesktopPetAgentOption,
  DesktopPetState,
  DesktopPetWindowMode
} from "../shared/contracts";
import type { AssistantNavigationStatusClient } from "./assistant/core/assistant-navigation-status-client";
import type {
  DesktopPetBoundAgentStatus,
  DesktopPetLocalStatus,
  readDesktopPetStoredState
} from "./assistant/pet/desktop-pet";
import type { TaskBoardRuntime } from "./task-board-runtime";

type DesktopPetSettingsState = ReturnType<typeof readDesktopPetStoredState>;

export interface MainAppState {
  mainWindow: BrowserWindow | null;
  desktopPetWindow: BrowserWindow | null;
  isHandlingQuit: boolean;
  desktopSsoWebviewCompletionInFlight: boolean;
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
  desktopPetRendererWindowMode: DesktopPetWindowMode;
  desktopPetIdleResetTimer: ReturnType<typeof setTimeout> | null;
  assistantNavigationStatusClient: AssistantNavigationStatusClient | null;
  desktopPetPendingProgrammaticBoundsSignature: string | null;
  desktopPetProgrammaticBoundsGuardTimer: ReturnType<typeof setTimeout> | null;
  desktopPetMouseInteractive: boolean;
  taskBoardRuntime: TaskBoardRuntime | null;
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
    desktopSsoWebviewCompletionInFlight: initialState.desktopSsoWebviewCompletionInFlight ?? false,
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
    desktopPetRendererWindowMode: initialState.desktopPetRendererWindowMode ?? "base",
    desktopPetIdleResetTimer: initialState.desktopPetIdleResetTimer ?? null,
    assistantNavigationStatusClient: initialState.assistantNavigationStatusClient ?? null,
    desktopPetPendingProgrammaticBoundsSignature: initialState.desktopPetPendingProgrammaticBoundsSignature ?? null,
    desktopPetProgrammaticBoundsGuardTimer: initialState.desktopPetProgrammaticBoundsGuardTimer ?? null,
    desktopPetMouseInteractive: initialState.desktopPetMouseInteractive ?? true,
    taskBoardRuntime: initialState.taskBoardRuntime ?? null,
    desktopActionRendererRequests: initialState.desktopActionRendererRequests ?? new Map(),
    logStreamSubscriptions: initialState.logStreamSubscriptions ?? new Map()
  };
}
