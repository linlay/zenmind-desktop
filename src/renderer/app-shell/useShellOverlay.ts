import { useCallback, useReducer, useRef } from "react";

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
  const shareSessionIdRef = useRef(0);
  activeOverlayRef.current = activeOverlay;

  const openGlobalSearch = useCallback(() => {
    const overlay = { kind: "globalSearch" } as const;
    activeOverlayRef.current = overlay;
    dispatch({ type: "open", overlay });
  }, []);

  const closeGlobalSearch = useCallback((overlay: { kind: "globalSearch" }) => {
    if (activeOverlayRef.current !== overlay) {
      return;
    }
    activeOverlayRef.current = null;
    dispatch({ type: "close", overlay });
  }, []);

  const requestToolMenuOpen = useCallback(
    () => {
      // Identity is maintained in the background; opening a menu must stay local.
      const overlay = { kind: "toolMenu" } as const;
      activeOverlayRef.current = overlay;
      dispatch({ type: "open", overlay });
    },
    [],
  );

  const openToolMenuIfIdle = useCallback(() => {
    if (activeOverlayRef.current) {
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
    if (!overlay) {
      return;
    }
    activeOverlayRef.current = null;
    dispatch({ type: "close", overlay });
  }, []);

  const openConversationShare = useCallback(
    (chatId: string, chatName: string) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        return;
      }
      shareSessionIdRef.current += 1;
      const overlay = {
        kind: "conversationShare" as const,
        chatId: normalizedChatId,
        chatName: chatName.trim() || normalizedChatId,
        sessionId: shareSessionIdRef.current,
      };
      activeOverlayRef.current = overlay;
      dispatch({
        type: "open",
        overlay,
      });
    },
    [],
  );

  const closeConversationShare = useCallback(
    (overlay: Extract<Exclude<ShellOverlay, null>, { kind: "conversationShare" }>) => {
      if (activeOverlayRef.current !== overlay) {
        return;
      }
      activeOverlayRef.current = null;
      dispatch({ type: "close", overlay });
    },
    [],
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
