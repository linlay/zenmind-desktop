/**
 * Login-form observer that runs in an isolated JavaScript world of a guest page.
 * Page scripts cannot reach that world, so they can neither read what it captures
 * nor forge its events. Main pulls events through `next()`; nothing is pushed out.
 *
 * It only looks at visible login inputs at the moment the user submits them: it keeps
 * no keystroke history and never reads other fields or network traffic.
 */
export const LOGIN_OBSERVER_WORLD_ID = 1777;

export type LoginObserverEvent =
  /** The first page of a two-step login: an identifier submitted without a password. */
  | { type: "username"; origin: string; username: string }
  | { type: "credential"; origin: string; username: string; password: string };

function loginObserver(maxUsername: number, maxPassword: number) {
  const scope = globalThis as unknown as { __desktopLoginObserver?: { next(): Promise<unknown>; hasPasswordField(): boolean } };
  if (scope.__desktopLoginObserver) return;
  const queue: unknown[] = [];
  let waiter: ((event: unknown) => void) | null = null;
  const emit = (event: unknown) => {
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); }
    else if (queue.length < 8) queue.push(event);
  };

  const visible = (element: Element): element is HTMLInputElement => {
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly && element.type !== "password") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const inputs = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const passwordFields = (root: ParentNode) => inputs(root, "input[type=password]");
  const identifierFields = (root: ParentNode) => inputs(root, "input").filter(input => ["text", "email", "tel", ""].includes(input.type));
  const looksLikeIdentifier = (input: HTMLInputElement) =>
    /username|email|tel/u.test(input.autocomplete) || input.type === "email"
    || /user|login|account|email|phone|mobile|identifier/iu.test(`${input.name} ${input.id}`);

  /** The identifier belonging to a password field: marked as one, else the closest text input before it. */
  function usernameFor(password: HTMLInputElement) {
    const candidates = identifierFields(password.form ?? document).filter(input => input.value.trim());
    const marked = candidates.find(input => /username|email/u.test(input.autocomplete));
    if (marked) return marked.value.trim();
    const before = candidates.filter(input => input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return (before[before.length - 1] ?? candidates[0])?.value.trim() ?? "";
  }

  let lastSignature = "";
  function capture(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    const form = element?.closest("form") ?? null;
    let fields = passwordFields(form ?? document).filter(input => input.value);
    // A click outside any form only counts when the page shows exactly one filled login.
    if (!form && fields.length && element && !element.closest("button, [role=button], input[type=submit], input[type=button], a") && !(element instanceof HTMLInputElement)) return;
    if (!fields.length) {
      const identifier = identifierFields(form ?? document).filter(input => input.value.trim() && looksLikeIdentifier(input));
      if (identifier.length === 1 && !passwordFields(document).length && identifier[0].value.length <= maxUsername) {
        emit({ type: "username", origin: location.origin, username: identifier[0].value.trim() });
      }
      return;
    }
    let chosen = fields[0];
    if (fields.length > 1) {
      // Sign-up, reset and change-password forms: keep only the new password, which is entered twice or marked as new.
      const marked = fields.find(input => input.autocomplete === "new-password");
      const repeated = fields.find((input, index) => fields.some((other, otherIndex) => otherIndex > index && other.value === input.value));
      const next = marked ?? repeated;
      if (!next) return;
      chosen = next;
    }
    const username = usernameFor(chosen);
    if (chosen.value.length > maxPassword || username.length > maxUsername) return;
    // Submit, click and Enter often fire together for one attempt.
    const signature = `${username}\u0000${chosen.value}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    setTimeout(() => { lastSignature = ""; }, 1500);
    emit({ type: "credential", origin: location.origin, username, password: chosen.value });
  }

  // Capture phase: read the values before the page clears the form or navigates.
  addEventListener("submit", event => capture(event.target), true);
  addEventListener("click", event => {
    const element = event.target instanceof Element ? event.target.closest("button, [role=button], input[type=submit], input[type=button], a") : null;
    if (element) capture(element);
  }, true);
  addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) capture(event.target);
  }, true);

  scope.__desktopLoginObserver = {
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiter = resolve; }),
    hasPasswordField: () => passwordFields(document).length > 0
  };
}

export function buildLoginObserverInstallScript(limits: { maxUsername: number; maxPassword: number }) {
  return `(${loginObserver.toString()})(${limits.maxUsername}, ${limits.maxPassword}); void 0;`;
}
export const LOGIN_OBSERVER_NEXT_SCRIPT = "globalThis.__desktopLoginObserver ? globalThis.__desktopLoginObserver.next() : null";
export const LOGIN_OBSERVER_PASSWORD_FIELD_SCRIPT = "globalThis.__desktopLoginObserver ? globalThis.__desktopLoginObserver.hasPasswordField() : null";
