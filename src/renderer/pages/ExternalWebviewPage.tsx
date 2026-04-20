import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { QiuerLoginCredentials } from "../../shared/contracts";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
};

type WebviewElement = HTMLElement & {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
};

type CapturedLoginCredentials = {
  account: string;
  password: string;
};

function isQiuerUrl(url: string) {
  try {
    return new URL(url).hostname === "station.qiuer.net";
  } catch {
    return false;
  }
}

function buildQiuerAutologinScript(credentials: QiuerLoginCredentials) {
  return `
(() => {
  const credentials = ${JSON.stringify({
    account: credentials.account,
    password: credentials.password
  })};
  if (!location.hostname.endsWith("station.qiuer.net")) return { skipped: "host" };
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const metaText = (input) => [
    input.name,
    input.id,
    input.autocomplete,
    input.placeholder,
    input.getAttribute("aria-label")
  ].filter(Boolean).join(" ").toLowerCase();
  const isChallengeField = (input) => /captcha|verify|verification|sms|otp|mfa|code|验证码|校验|短信|动态/.test(metaText(input));
  const setValue = (input, value) => {
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const allInputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const passwordInput = allInputs.find((input) => String(input.type || "").toLowerCase() === "password");
  if (!passwordInput) return { skipped: "password" };
  const form = passwordInput.closest("form");
  const scope = form || document;
  const inputs = Array.from(scope.querySelectorAll("input")).filter(visible);
  const accountInput = inputs.find((input) => {
    if (input === passwordInput || isChallengeField(input)) return false;
    const type = String(input.type || "text").toLowerCase();
    return ["", "text", "email", "tel", "number"].includes(type);
  });
  const hasChallenge = inputs.some((input) => input !== passwordInput && isChallengeField(input));
  const alreadySubmitted = window.__zenmindQiuerAutoLoginSubmitted === true;
  if (!alreadySubmitted) {
    if (accountInput) setValue(accountInput, credentials.account);
    setValue(passwordInput, credentials.password);
  }
  if (hasChallenge) return { filled: true, submitted: false, blockedByChallenge: true };
  if (alreadySubmitted) return { filled: true, submitted: false, skipped: "already_submitted" };
  const loginControls = Array.from(scope.querySelectorAll("button,input[type='submit'],input[type='button'],[role='button']"))
    .filter(visible);
  const loginControl = loginControls.find((element) => /登录|登\\s*录|login|sign\\s*in/i.test(
    element.innerText || element.value || element.getAttribute("aria-label") || ""
  ));
  window.__zenmindQiuerAutoLoginSubmitted = true;
  if (loginControl && !loginControl.disabled) {
    loginControl.click();
    return { filled: true, submitted: true, method: "click" };
  }
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return { filled: true, submitted: true, method: "requestSubmit" };
  }
  if (form) {
    form.submit();
    return { filled: true, submitted: true, method: "submit" };
  }
  return { filled: true, submitted: false, skipped: "no_submit" };
})()
`;
}

function buildQiuerCaptureScript() {
  return `
(() => {
  if (!location.hostname.endsWith("station.qiuer.net")) return null;
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const metaText = (input) => [
    input.name,
    input.id,
    input.autocomplete,
    input.placeholder,
    input.getAttribute("aria-label")
  ].filter(Boolean).join(" ").toLowerCase();
  const isChallengeField = (input) => /captcha|verify|verification|sms|otp|mfa|code|验证码|校验|短信|动态/.test(metaText(input));
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const passwordInput = inputs.find((input) => String(input.type || "").toLowerCase() === "password" && input.value);
  if (!passwordInput) return null;
  const form = passwordInput.closest("form");
  const scope = form || document;
  const scopedInputs = Array.from(scope.querySelectorAll("input")).filter(visible);
  const accountInput = scopedInputs.find((input) => {
    if (input === passwordInput || isChallengeField(input) || !input.value) return false;
    const type = String(input.type || "text").toLowerCase();
    return ["", "text", "email", "tel", "number"].includes(type);
  });
  if (!accountInput) return null;
  return {
    account: String(accountInput.value || "").trim(),
    password: String(passwordInput.value || "")
  };
})()
`;
}

export function ExternalWebviewPage({ title, url }: ExternalWebviewPageProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const savedSignatureRef = useRef("");
  const [qiuerCredentials, setQiuerCredentials] = useState<QiuerLoginCredentials | null>(null);
  const qiuerEnabled = isQiuerUrl(url);

  useEffect(() => {
    if (!qiuerEnabled) {
      setQiuerCredentials(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.credentials
      .getQiuerLogin()
      .then((result) => {
        if (!cancelled && result.ok) {
          setQiuerCredentials(result.credentials);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [qiuerEnabled]);

  useEffect(() => {
    if (!qiuerCredentials) {
      savedSignatureRef.current = "";
      return;
    }
    savedSignatureRef.current = `${qiuerCredentials.account}\n${qiuerCredentials.password}`;
  }, [qiuerCredentials]);

  const runQiuerAutologin = useCallback(() => {
    const webview = webviewRef.current;
    if (!qiuerEnabled || !webview || !qiuerCredentials) {
      return;
    }
    webview.executeJavaScript(buildQiuerAutologinScript(qiuerCredentials), false).catch(() => undefined);
  }, [qiuerCredentials, qiuerEnabled]);

  const captureQiuerCredentials = useCallback(() => {
    const webview = webviewRef.current;
    if (!qiuerEnabled || !webview) {
      return;
    }
    webview
      .executeJavaScript(buildQiuerCaptureScript(), false)
      .then((value) => {
        const credentials = value as Partial<CapturedLoginCredentials> | null;
        if (!credentials || typeof credentials.account !== "string" || typeof credentials.password !== "string") {
          return;
        }
        const signature = `${credentials.account}\n${credentials.password}`;
        if (!credentials.account || !credentials.password || signature === savedSignatureRef.current) {
          return;
        }
        savedSignatureRef.current = signature;
        window.electronAPI.credentials.saveQiuerLogin({
          account: credentials.account,
          password: credentials.password
        }).catch(() => undefined);
      })
      .catch(() => undefined);
  }, [qiuerEnabled]);

  useEffect(() => {
    if (!qiuerEnabled) {
      return;
    }
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }
    const handleReady = () => {
      runQiuerAutologin();
      window.setTimeout(captureQiuerCredentials, 500);
    };
    webview.addEventListener("dom-ready", handleReady);
    webview.addEventListener("did-navigate", handleReady);
    webview.addEventListener("did-navigate-in-page", handleReady);
    handleReady();
    const timer = window.setInterval(() => {
      runQiuerAutologin();
      captureQiuerCredentials();
    }, 1500);
    return () => {
      webview.removeEventListener("dom-ready", handleReady);
      webview.removeEventListener("did-navigate", handleReady);
      webview.removeEventListener("did-navigate-in-page", handleReady);
      window.clearInterval(timer);
    };
  }, [captureQiuerCredentials, qiuerEnabled, runQiuerAutologin]);

  return (
    <section className="pan-page">
      <div className="pan-frame-shell">
        {createElement("webview", {
          ref: webviewRef,
          src: url,
          title,
          className: "pan-frame",
          allowpopups: "true",
          style: { width: "100%", height: "100%", border: "none" }
        })}
      </div>
    </section>
  );
}
