import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useAppContext } from '@/app/state/AppContext';
import { getAgent, getAgents, getChats, getTeams, setAccessToken } from '@/features/transport/lib/apiClientProxy';
import type { Agent, Chat, Team, WorkerRow } from '@/app/state/types';
import { isAppMode } from '@/shared/utils/routing';
import {
  refreshWorkerDataWithCoordinator,
  type WorkerDataSnapshot,
  type WorkerRefreshOverrides,
} from '@/features/workers/lib/workerDataCoordinator';
import { buildWorkerRows } from '@/features/workers/lib/workerListFormatter';
import {
  buildSelectedWorkerConversationRows,
  mergeFetchedChats,
} from '@/features/chats/lib/chatSummary';
import { upsertAgentSummary } from '@/features/workers/lib/agentSummary';

const ASSISTANT_WORKER_INTENT_STORAGE_KEY = 'zenmind-desktop.assistantWorkerIntent';
const ASSISTANT_WORKER_INTENT_MAX_AGE_MS = 10 * 60 * 1000;

type WorkerSelectionDetail = {
  workerKey?: unknown;
  agentKey?: unknown;
  displayName?: unknown;
  workerName?: unknown;
  name?: unknown;
  role?: unknown;
  focusComposerOnComplete?: unknown;
  createdAt?: unknown;
};

function normalizeWorkerLabel(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function shouldStartInitialWorkerRefresh(input: {
  hasStarted: boolean;
  appMode: boolean;
  accessToken: string;
  lastStartedToken: string;
}): boolean {
  const accessToken = String(input.accessToken || '').trim();
  const lastStartedToken = String(input.lastStartedToken || '').trim();

  if (input.hasStarted) {
    return Boolean(accessToken) && accessToken !== lastStartedToken;
  }

  if (!input.appMode) {
    return true;
  }

  return Boolean(accessToken);
}

export function useWorkerData(input: {
  loadChat: (chatId: string, options?: { focusComposerOnComplete?: boolean }) => Promise<void>;
  selectWorkerConversation: (workerKey: string, options?: { focusComposerOnComplete?: boolean }) => Promise<void>;
}) {
  const { loadChat, selectWorkerConversation } = input;
  const { state, dispatch, stateRef } = useAppContext();
  const initialRefreshStartedRef = useRef(false);
  const initialRefreshTokenRef = useRef('');
  const appMode = isAppMode();

  const extractAgentWorkerKey = useCallback((detail: { workerKey?: unknown; agentKey?: unknown }): string => {
    const explicitAgentKey = String(detail.agentKey || '').trim();
    if (explicitAgentKey) {
      return `agent:${explicitAgentKey}`;
    }
    const workerKey = String(detail.workerKey || '').trim();
    return workerKey.startsWith('agent:') ? workerKey : '';
  }, []);

  const findDefaultTeamWorkerKey = useCallback((rows: WorkerRow[]): string => {
    const matched = rows.find((row) => {
      if (row.type !== 'team') return false;
      const name = String(row.displayName || '').trim().toLowerCase();
      const sourceId = String(row.sourceId || '').trim().toLowerCase();
      return name === 'default team'
        || name === 'default_team'
        || name === '默认小组'
        || sourceId === 'default_team'
        || sourceId === 'default';
    });
    return matched?.key || '';
  }, []);

  const ensureWorkerSelection = useCallback((rows: WorkerRow[], preferredWorkerKey = ''): string => {
    const preferred = String(preferredWorkerKey || '').trim();
    if (preferred && rows.some((row) => row.key === preferred)) {
      return preferred;
    }
    const current = String(stateRef.current.workerSelectionKey || '').trim();
    if (current && rows.some((row) => row.key === current)) {
      return current;
    }
    const defaultTeamKey = findDefaultTeamWorkerKey(rows);
    if (defaultTeamKey) return defaultTeamKey;
    return rows[0]?.key || '';
  }, [findDefaultTeamWorkerKey, stateRef]);

  const resolveWorkerKeyFromLabel = useCallback((detail: WorkerSelectionDetail): string => {
    const requestedLabels = [detail.displayName, detail.workerName, detail.name]
      .map(normalizeWorkerLabel)
      .filter(Boolean);
    if (requestedLabels.length === 0) {
      return '';
    }

    const rows = stateRef.current.workerRows || [];
    const requestedRole = normalizeWorkerLabel(detail.role);
    if (requestedRole) {
      const exactRoleMatch = rows.find((row) => {
        const displayName = normalizeWorkerLabel(row.displayName);
        const sourceId = normalizeWorkerLabel(row.sourceId);
        const role = normalizeWorkerLabel(row.role);
        const labelMatches = requestedLabels.includes(displayName) || requestedLabels.includes(sourceId);
        return labelMatches && role === requestedRole;
      });
      if (exactRoleMatch) {
        return exactRoleMatch.key;
      }
    }

    const exactMatch = rows.find((row) => {
      const displayName = normalizeWorkerLabel(row.displayName);
      const sourceId = normalizeWorkerLabel(row.sourceId);
      return requestedLabels.includes(displayName) || requestedLabels.includes(sourceId);
    });
    if (exactMatch) {
      return exactMatch.key;
    }

    const fuzzyMatch = rows.find((row) => {
      const displayName = normalizeWorkerLabel(row.displayName);
      if (!displayName) {
        return false;
      }
      return requestedLabels.some((label) => displayName.includes(label) || label.includes(displayName));
    });
    return fuzzyMatch?.key || '';
  }, [stateRef]);

  const resolveWorkerKeyFromDetail = useCallback((detail: WorkerSelectionDetail): string => {
    const requestedWorkerKey = String(detail.workerKey || '').trim();
    const fallbackWorkerKey = extractAgentWorkerKey(detail);
    return requestedWorkerKey || fallbackWorkerKey || resolveWorkerKeyFromLabel(detail);
  }, [extractAgentWorkerKey, resolveWorkerKeyFromLabel]);

  const rebuildWorkerRowsFromState = useCallback((overrides: WorkerRefreshOverrides = {}) => {
    const current = stateRef.current;
    const agents = overrides.agents ?? current.agents;
    const teams = overrides.teams ?? current.teams;
    const chats = overrides.chats ?? current.chats;
    const rows = buildWorkerRows({
      agents,
      teams,
      chats,
      workerPriorityKey: overrides.workerPriorityKey ?? current.workerPriorityKey,
    });
    const workerSelectionKey = ensureWorkerSelection(rows, overrides.workerSelectionKey ?? current.workerSelectionKey);
    if (workerSelectionKey) {
      dispatch({ type: 'SET_WORKER_SELECTION_KEY', workerKey: workerSelectionKey });
    }
    dispatch({ type: 'SET_WORKER_ROWS', rows });

    const workerIndexByKey = new Map(rows.map((row) => [row.key, row] as const));
    const workerChats = buildSelectedWorkerConversationRows({
      chats,
      workerSelectionKey,
      workerIndexByKey,
    });
    dispatch({ type: 'SET_WORKER_RELATED_CHATS', chats: workerChats });
  }, [dispatch, ensureWorkerSelection, stateRef]);

  const getWorkerDataSnapshot = useCallback((): WorkerDataSnapshot => ({
    agents: stateRef.current.agents,
    teams: stateRef.current.teams,
    chats: stateRef.current.chats,
    workerSelectionKey: stateRef.current.workerSelectionKey,
    workerPriorityKey: stateRef.current.workerPriorityKey,
  }), [stateRef]);

  const runWithSidebarLoading = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    dispatch({ type: 'START_SIDEBAR_REQUEST' });
    try {
      return await task();
    } finally {
      dispatch({ type: 'FINISH_SIDEBAR_REQUEST' });
    }
  }, [dispatch]);

  const loadAgents = useCallback(async () => {
    await runWithSidebarLoading(async () => {
      try {
        const response = await getAgents();
        const agents = (response.data as Agent[]) || [];
        dispatch({ type: 'SET_AGENTS', agents });
        rebuildWorkerRowsFromState({ agents });
      } catch (error) {
        dispatch({ type: 'APPEND_DEBUG', line: `[loadAgents error] ${(error as Error).message}` });
      }
    });
  }, [dispatch, rebuildWorkerRowsFromState, runWithSidebarLoading]);

  const loadTeams = useCallback(async () => {
    await runWithSidebarLoading(async () => {
      try {
        const response = await getTeams();
        const teams = (response.data as Team[]) || [];
        dispatch({ type: 'SET_TEAMS', teams });
        rebuildWorkerRowsFromState({ teams });
      } catch (error) {
        dispatch({ type: 'APPEND_DEBUG', line: `[loadTeams error] ${(error as Error).message}` });
      }
    });
  }, [dispatch, rebuildWorkerRowsFromState, runWithSidebarLoading]);

  const loadChats = useCallback(async () => {
    await runWithSidebarLoading(async () => {
      try {
        const response = await getChats();
        const chats = mergeFetchedChats(stateRef.current.chats, (response.data as Chat[]) || []);
        dispatch({ type: 'SET_CHATS', chats });
        rebuildWorkerRowsFromState({ chats });
      } catch (error) {
        dispatch({ type: 'APPEND_DEBUG', line: `[loadChats error] ${(error as Error).message}` });
      }
    });
  }, [dispatch, rebuildWorkerRowsFromState, runWithSidebarLoading, stateRef]);

  const refreshWorkerData = useCallback(async () => {
    await runWithSidebarLoading(async () => {
      await refreshWorkerDataWithCoordinator({
        fetchAgents: async () => {
          const response = await getAgents();
          return (response.data as Agent[]) || [];
        },
        fetchTeams: async () => {
          const response = await getTeams();
          return (response.data as Team[]) || [];
        },
        fetchChats: async () => {
          const response = await getChats();
          return (response.data as Chat[]) || [];
        },
        getSnapshot: getWorkerDataSnapshot,
        applyAgents: (agents) => {
          dispatch({ type: 'SET_AGENTS', agents });
        },
        applyTeams: (teams) => {
          dispatch({ type: 'SET_TEAMS', teams });
        },
        applyChats: (chats) => {
          dispatch({ type: 'SET_CHATS', chats });
        },
        rebuildWorkerRows: rebuildWorkerRowsFromState,
        appendDebug: (line) => {
          dispatch({ type: 'APPEND_DEBUG', line });
        },
      });
    });
  }, [dispatch, getWorkerDataSnapshot, rebuildWorkerRowsFromState, runWithSidebarLoading]);

  const ensureAgentLoadedForWorkerSelection = useCallback(async (
    detail: { workerKey?: unknown; agentKey?: unknown },
  ): Promise<string> => {
    const agentWorkerKey = extractAgentWorkerKey(detail);
    if (!agentWorkerKey) {
      return String(detail.workerKey || '').trim();
    }

    const requestedAgentKey = agentWorkerKey.slice('agent:'.length).trim();
    if (!requestedAgentKey) {
      return String(detail.workerKey || '').trim();
    }

    try {
      const response = await getAgent(requestedAgentKey);
      const payload = (response.data || {}) as Partial<Agent>;
      const resolvedAgentKey = String(payload.key || requestedAgentKey).trim() || requestedAgentKey;
      const mergedAgents = upsertAgentSummary(stateRef.current.agents, {
        ...payload,
        key: resolvedAgentKey,
      });

      flushSync(() => {
        dispatch({ type: 'SET_AGENTS', agents: mergedAgents });
        rebuildWorkerRowsFromState({
          agents: mergedAgents,
          workerPriorityKey: `agent:${resolvedAgentKey}`,
          workerSelectionKey: `agent:${resolvedAgentKey}`,
        });
      });

      return `agent:${resolvedAgentKey}`;
    } catch (error) {
      dispatch({
        type: 'APPEND_DEBUG',
        line: `[loadAgent error] ${(error as Error).message}`,
      });
      return agentWorkerKey;
    }
  }, [dispatch, extractAgentWorkerKey, rebuildWorkerRowsFromState, stateRef]);

  const selectWorkerFromDetail = useCallback(async (detail: WorkerSelectionDetail): Promise<boolean> => {
    const focusComposerOnComplete = Boolean(detail.focusComposerOnComplete);
    let nextWorkerKey = resolveWorkerKeyFromDetail(detail);

    if (!nextWorkerKey && (detail.displayName || detail.workerName || detail.name)) {
      await refreshWorkerData();
      nextWorkerKey = resolveWorkerKeyFromDetail(detail);
    }

    if (!nextWorkerKey) {
      return false;
    }

    const resolvedWorkerKey = await ensureAgentLoadedForWorkerSelection({
      ...detail,
      workerKey: nextWorkerKey,
    });
    await selectWorkerConversation(resolvedWorkerKey || nextWorkerKey, { focusComposerOnComplete });
    return true;
  }, [
    ensureAgentLoadedForWorkerSelection,
    refreshWorkerData,
    resolveWorkerKeyFromDetail,
    selectWorkerConversation,
  ]);

  const clearPendingAssistantWorkerIntent = useCallback(() => {
    try {
      window.sessionStorage.removeItem(ASSISTANT_WORKER_INTENT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const readPendingAssistantWorkerIntent = useCallback((): WorkerSelectionDetail | null => {
    try {
      const raw = window.sessionStorage.getItem(ASSISTANT_WORKER_INTENT_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as WorkerSelectionDetail;
      const createdAt = Number(parsed.createdAt || 0);
      if (createdAt > 0 && Date.now() - createdAt > ASSISTANT_WORKER_INTENT_MAX_AGE_MS) {
        clearPendingAssistantWorkerIntent();
        return null;
      }
      return parsed;
    } catch {
      clearPendingAssistantWorkerIntent();
      return null;
    }
  }, [clearPendingAssistantWorkerIntent]);

  useEffect(() => {
    setAccessToken(state.accessToken);
  }, [state.accessToken]);

  useEffect(() => {
    const accessToken = String(state.accessToken || '').trim();

    if (!shouldStartInitialWorkerRefresh({
      hasStarted: initialRefreshStartedRef.current,
      appMode,
      accessToken,
      lastStartedToken: initialRefreshTokenRef.current,
    })) {
      return;
    }

    initialRefreshStartedRef.current = true;
    initialRefreshTokenRef.current = accessToken;
    setAccessToken(accessToken);
    refreshWorkerData().catch(() => undefined);
  }, [appMode, refreshWorkerData, state.accessToken]);

  useEffect(() => {
    const handler = (e: Event) => {
      const chatId = (e as CustomEvent).detail?.chatId;
      const focusComposerOnComplete = Boolean((e as CustomEvent).detail?.focusComposerOnComplete);
      if (chatId) loadChat(chatId, { focusComposerOnComplete }).catch(() => undefined);
    };
    window.addEventListener('agent:load-chat', handler);
    return () => window.removeEventListener('agent:load-chat', handler);
  }, [loadChat]);

  useEffect(() => {
    const handler = () => {
      loadAgents().catch(() => undefined);
    };
    window.addEventListener('agent:refresh-agents', handler);
    return () => window.removeEventListener('agent:refresh-agents', handler);
  }, [loadAgents]);

  useEffect(() => {
    const handler = () => {
      loadTeams().catch(() => undefined);
    };
    window.addEventListener('agent:refresh-teams', handler);
    return () => window.removeEventListener('agent:refresh-teams', handler);
  }, [loadTeams]);

  useEffect(() => {
    const handler = () => {
      loadChats().catch(() => undefined);
    };
    window.addEventListener('agent:refresh-chats', handler);
    return () => window.removeEventListener('agent:refresh-chats', handler);
  }, [loadChats]);

  useEffect(() => {
    const handler = () => {
      refreshWorkerData().catch(() => undefined);
    };
    window.addEventListener('agent:refresh-worker-data', handler);
    return () => window.removeEventListener('agent:refresh-worker-data', handler);
  }, [refreshWorkerData]);

  useEffect(() => {
    rebuildWorkerRowsFromState({
      workerPriorityKey: state.workerPriorityKey,
    });
  }, [rebuildWorkerRowsFromState, state.workerPriorityKey]);

  useEffect(() => {
    rebuildWorkerRowsFromState({
      chats: state.chats,
    });
  }, [rebuildWorkerRowsFromState, state.chats]);

  useEffect(() => {
    const handler = (e: Event) => {
      const mode = (e as CustomEvent).detail?.mode === 'worker' ? 'worker' : 'chat';
      dispatch({ type: 'SET_CONVERSATION_MODE', mode });
      dispatch({ type: 'SET_WORKER_CHAT_PANEL_COLLAPSED', collapsed: true });
      if (mode === 'worker') {
        rebuildWorkerRowsFromState();
      }
    };
    window.addEventListener('agent:set-conversation-mode', handler);
    return () => window.removeEventListener('agent:set-conversation-mode', handler);
  }, [dispatch, rebuildWorkerRowsFromState]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = ((e as CustomEvent).detail || {}) as WorkerSelectionDetail;
      selectWorkerFromDetail(detail)
        .then((handled) => {
          if (handled) {
            clearPendingAssistantWorkerIntent();
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener('agent:select-worker', handler);
    return () => window.removeEventListener('agent:select-worker', handler);
  }, [clearPendingAssistantWorkerIntent, selectWorkerFromDetail]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;

    const tryPendingIntent = () => {
      if (disposed) {
        return;
      }
      const intent = readPendingAssistantWorkerIntent();
      if (!intent) {
        return;
      }

      selectWorkerFromDetail(intent)
        .then((handled) => {
          if (disposed) {
            return;
          }
          if (handled) {
            clearPendingAssistantWorkerIntent();
            return;
          }
          retryTimer = window.setTimeout(tryPendingIntent, 1000);
        })
        .catch(() => {
          if (!disposed) {
            retryTimer = window.setTimeout(tryPendingIntent, 1000);
          }
        });
    };

    tryPendingIntent();

    return () => {
      disposed = true;
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [clearPendingAssistantWorkerIntent, readPendingAssistantWorkerIntent, selectWorkerFromDetail]);

  return {
    loadAgents,
    loadTeams,
    loadChats,
    refreshWorkerData,
  };
}
