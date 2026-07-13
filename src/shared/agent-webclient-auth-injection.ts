import {
  AGENT_AUTH_REQUEST_TYPE,
  AGENT_AUTH_RESPONSE_TYPE
} from "./auth-bridge";

export function buildAgentWebclientAccessTokenInjectionScript(
  token: string | null,
  desktopAuthContext: string,
) {
  return `(() => {
    const token = ${JSON.stringify(token ?? "")};
    const desktopAuthContext = ${JSON.stringify(desktopAuthContext)};
    const accessTokenStorageKey = "agent-webclient.appAccessToken";
    const authContextStorageKey = "agent-webclient.appAuthContext";
    const bridgeFlag = "__DESKTOP_WEBVIEW_BRIDGE__";
    const fallbackFlag = "__DESKTOP_AGENT_WEBCLIENT_AUTH_FALLBACK__";
    const fallbackTokenKey = "__DESKTOP_AGENT_WEBCLIENT_FALLBACK_TOKEN__";
    const authRequestType = ${JSON.stringify(AGENT_AUTH_REQUEST_TYPE)};
    const authResponseType = ${JSON.stringify(AGENT_AUTH_RESPONSE_TYPE)};
    let tokenBefore = "";
    try {
      tokenBefore = window.sessionStorage.getItem(accessTokenStorageKey) || "";
    } catch {
      tokenBefore = "";
    }

    function writeToken(nextToken) {
      const normalizedToken = typeof nextToken === "string" ? nextToken.trim() : "";
      if (desktopAuthContext) {
        window.__AGENT_APP_AUTH_CONTEXT = desktopAuthContext;
      }
      try {
        if (desktopAuthContext) {
          const storedAuthContext = window.sessionStorage.getItem(authContextStorageKey) || "";
          if (storedAuthContext !== desktopAuthContext) {
            window.sessionStorage.removeItem(accessTokenStorageKey);
          }
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

    function defineWindowFlag(flag) {
      try {
        Object.defineProperty(window, flag, {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false
        });
      } catch {
        window[flag] = true;
      }
    }

    function markBridgeAvailable() {
      defineWindowFlag(bridgeFlag);
    }

    function isAuthRequest(value) {
      return Boolean(
        value &&
        typeof value === "object" &&
        value.type === authRequestType &&
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
          type: authResponseType,
          requestId: String(value.requestId),
          token: window[fallbackTokenKey] || null,
          desktopAuthContext: window.__AGENT_APP_AUTH_CONTEXT || desktopAuthContext || undefined
        },
        origin: location.origin,
        source: window
      }));
      return true;
    }

    markBridgeAvailable();
    const normalizedToken = writeToken(token);
    if (!window[fallbackFlag]) {
      defineWindowFlag(fallbackFlag);
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
