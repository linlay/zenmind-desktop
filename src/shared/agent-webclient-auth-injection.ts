export function buildAgentWebclientAccessTokenInjectionScript(
  token: string | null,
  desktopAuthContext: string,
) {
  return `(() => {
    const token = ${JSON.stringify(token ?? "")};
    const desktopAuthContext = ${JSON.stringify(desktopAuthContext)};
    const accessTokenStorageKey = "agent-webclient.appAccessToken";
    const authContextStorageKey = "agent-webclient.appAuthContext";
    const bridgeFlag = "__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__";
    const fallbackFlag = "__ZENMIND_AGENT_WEBCLIENT_AUTH_FALLBACK__";
    const fallbackTokenKey = "__ZENMIND_AGENT_WEBCLIENT_FALLBACK_TOKEN__";
    let tokenBefore = "";
    try {
      tokenBefore = window.sessionStorage.getItem(accessTokenStorageKey) || "";
    } catch {
      tokenBefore = "";
    }

    function writeToken(nextToken) {
      const normalizedToken = typeof nextToken === "string" ? nextToken.trim() : "";
      try {
        if (desktopAuthContext) {
          window.sessionStorage.setItem(authContextStorageKey, desktopAuthContext);
        }
        if (normalizedToken) {
          window.sessionStorage.setItem(accessTokenStorageKey, normalizedToken);
        } else {
          window.sessionStorage.removeItem(accessTokenStorageKey);
        }
      } catch {
        // Ignore restricted guest storage.
      }
      window.__AGENT_APP_ACCESS_TOKEN = normalizedToken || undefined;
      window[fallbackTokenKey] = normalizedToken;
      return normalizedToken;
    }

    function markBridgeAvailable() {
      try {
        Object.defineProperty(window, bridgeFlag, {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false
        });
      } catch {
        window[bridgeFlag] = true;
      }
    }

    function isAuthRequest(value) {
      return Boolean(
        value &&
        typeof value === "object" &&
        value.type === "zenmind:agent-app-auth:request" &&
        value.requestId &&
        (value.action === "getAccessToken" || value.action === "refreshAccessToken")
      );
    }

    function respondToAuthRequest(value) {
      if (!isAuthRequest(value)) {
        return false;
      }
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "zenmind:agent-app-auth:response",
          requestId: String(value.requestId),
          token: window[fallbackTokenKey] || null
        },
        origin: location.origin,
        source: window
      }));
      return true;
    }

    markBridgeAvailable();
    const normalizedToken = writeToken(token);
    if (!window[fallbackFlag]) {
      try {
        Object.defineProperty(window, fallbackFlag, {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false
        });
      } catch {
        window[fallbackFlag] = true;
      }
      window.addEventListener("message", (event) => {
        respondToAuthRequest(event.data);
      });
    }

    return {
      bridge: Boolean(window[bridgeFlag]),
      tokenBeforeLength: tokenBefore.length,
      tokenAfterLength: normalizedToken.length
    };
  })()`;
}
