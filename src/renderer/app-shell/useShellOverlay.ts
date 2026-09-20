import { useCallback, useEffect, useReducer, useRef } from "react";

export type ShellOverlay =
  | { kind: "toolMenu" }
  | { kind: "globalSearch" }
  | {
      kind: "conversationShare";
      chatId: string;
      chatName: string;
      sessionId: number;
    }
  | null;

export type ShellOverlayAction =
  | { type: "open"; overlay: Exclude<ShellOverlay, null> }
  | {
      type: "close";
      overlay: Exclude<ShellOverlay, null>;
    };

export function reduceShellOverlay(
  current: ShellOverlay,
  action: ShellOverlayAction,
): ShellOverlay {
  if (action.type === "open") {
    return action.overlay;
  }
  return current === action.overlay ? null : current;
}

export function useShellOverlay() {
  const [activeOverlay, dispatch] = useReducer(reduceShellOverlay, null);
  const activeOverlayRef = useRef<ShellOverlay>(null);
  const toolMenuRequestIdRef = useRef(0);
  const toolMenuRequestPendingRef = useRef(false);
  const shareSessionIdRef = useRef(0);
  activeOverlayRef.current = activeOverlay;

  const cancelPendingToolMenuOpen = useCallback(() => {
    toolMenuRequestIdRef.current += 1;
    toolMenuRequestPendingRef.current = false;
  }, []);

  useEffect(
    () => () => {
      cancelPendingToolMenuOpen();
    },
    [cancelPendingToolMenuOpen],
  );

  const openGlobalSearch = useCallback(() => {
    cancelPendingToolMenuOpen();
    const overlay = { kind: "globalSearch" } as const;
    activeOverlayRef.current = overlay;
    dispatch({ type: "open", overlay });
  }, [cancelPendingToolMenuOpen]);

  const closeGlobalSearch = useCallback((overlay: { kind: "globalSearch" }) => {
    if (activeOverlayRef.current !== overlay) {
      return;
    }
    cancelPendingToolMenuOpen();
    activeOverlayRef.current = null;
    dispatch({ type: "close", overlay });
  }, [cancelPendingToolMenuOpen]);

  const requestToolMenuOpen = useCallback(
    async (refresh?: () => Promise<void> | void) => {
      const requestId = toolMenuRequestIdRef.current + 1;
      toolMenuRequestIdRef.current = requestId;
      toolMenuRequestPendingRef.current = true;
      try {
        await refresh?.();
      } catch {
        // Account refresh failure must not prevent the existing menu from opening.
      }
      if (toolMenuRequestIdRef.current !== requestId) {
        return;
      }
      toolMenuRequestPendingRef.current = false;
      const overlay = { kind: "toolMenu" } as const;
      activeOverlayRef.current = overlay;
      dispatch({ type: "open", overlay });
    },
    [],
  );

  const openToolMenuIfIdle = useCallback(() => {
    if (activeOverlayRef.current || toolMenuRequestPendingRef.current) {
      return;
    }
    const overlay = { kind: "toolMenu" } as const;
    activeOverlayRef.current = overlay;
    dispatch({ type: "open", overlay });
  }, []);

  const closeToolMenu = useCallback((overlay: { kind: "toolMenu" } | null) => {
    if (overlay && activeOverlayRef.current !== overlay) {
      return;
    }
    cancelPendingToolMenuOpen();
    if (!overlay) {
      return;
    }
    activeOverlayRef.current = null;
    dispatch({ type: "close", overlay });
  }, [cancelPendingToolMenuOpen]);

  const openConversationShare = useCallback(
    (chatId: string, chatName: string) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        return;
      }
      cancelPendingToolMenuOpen();
      shareSessionIdRef.current += 1;
      const overlay = {
        kind: "conversationShare" as const,
        chatId: normalizedChatId,
        chatName: chatName.trim(),
        sessionId: shareSessionIdRef.current,
      };
      activeOverlayRef.current = overlay;
      dispatch({
        type: "open",
        overlay,
      });
    },
    [cancelPendingToolMenuOpen],
  );

  const closeConversationShare = useCallback(
    (overlay: Extract<Exclude<ShellOverlay, null>, { kind: "conversationShare" }>) => {
      if (activeOverlayRef.current !== overlay) {
        return;
      }
      cancelPendingToolMenuOpen();
      activeOverlayRef.current = null;
      dispatch({ type: "close", overlay });
    },
    [cancelPendingToolMenuOpen],
  );

  return {
    activeOverlay,
    openGlobalSearch,
    closeGlobalSearch,
    requestToolMenuOpen,
    openToolMenuIfIdle,
    closeToolMenu,
    openConversationShare,
    closeConversationShare,
  };
}
