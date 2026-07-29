import type { BrowserWindow } from "electron";
import type {
  DesktopActionConfirmationResponse,
  CopilotDevToolsTarget,
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
import type { StartupPhase } from "./lifecycle/startup-phases";
import type { KanbanRuntime } from "./kanban-runtime";
import type { ShutdownMode, ShutdownReport } from "../shared/shutdown";

type DesktopPetSettingsState = ReturnType<typeof readDesktopPetStoredState>;

export interface MainAppState {
  mainWindow: BrowserWindow | null;
  desktopPetWindow: BrowserWindow | null;
  desktopPetPanelWindow: BrowserWindow | null;
  isHandlingQuit: boolean;
  desktopSsoWebviewCompletionInFlight: boolean;
  shutdownCleanupPromise: Promise<ShutdownReport> | null;
  shutdownCleanupComplete: boolean;
  shutdownMode: ShutdownMode;
  shutdownAckPaths: Set<string>;
  shutdownReport: ShutdownReport | null;
  serviceMutationQueue: Promise<void>;
  mainWindowSidebarTranslucencyEnabled: boolean;
  currentPageSnapshot: DesktopPageContextSnapshot | null;
  copilotDevToolsTarget: CopilotDevToolsTarget | null;
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
  kanbanRuntime: KanbanRuntime | null;
  desktopActionRendererRequests: Map<string, {
    resolve: (response: DesktopActionRendererResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  desktopActionConfirmationRequests: Map<string, {
    resolve: (response: DesktopActionConfirmationResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  startupPhase: StartupPhase;
}

export function createMainAppState(initialState: Partial<MainAppState> = {}): MainAppState {
  return {
    mainWindow: initialState.mainWindow ?? null,
    desktopPetWindow: initialState.desktopPetWindow ?? null,
    desktopPetPanelWindow: initialState.desktopPetPanelWindow ?? null,
    isHandlingQuit: initialState.isHandlingQuit ?? false,
    desktopSsoWebviewCompletionInFlight: initialState.desktopSsoWebviewCompletionInFlight ?? false,
    shutdownCleanupPromise: initialState.shutdownCleanupPromise ?? null,
    shutdownCleanupComplete: initialState.shutdownCleanupComplete ?? false,
    shutdownMode: initialState.shutdownMode ?? "user",
    shutdownAckPaths: initialState.shutdownAckPaths ?? new Set(),
    shutdownReport: initialState.shutdownReport ?? null,
    serviceMutationQueue: initialState.serviceMutationQueue ?? Promise.resolve(),
    mainWindowSidebarTranslucencyEnabled: initialState.mainWindowSidebarTranslucencyEnabled ?? true,
    currentPageSnapshot: initialState.currentPageSnapshot ?? null,
    copilotDevToolsTarget: initialState.copilotDevToolsTarget ?? null,
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
    kanbanRuntime: initialState.kanbanRuntime ?? null,
    desktopActionRendererRequests: initialState.desktopActionRendererRequests ?? new Map(),
    desktopActionConfirmationRequests: initialState.desktopActionConfirmationRequests ?? new Map(),
    startupPhase: initialState.startupPhase ?? "booting"
  };
}
