/**
 * Fills a login form from an isolated JavaScript world of a guest page (the same world
 * as the login observer). The script text carries the password, so it is built and
 * executed in Main only and never logged.
 *
 * The fill remembers the exact password field it wrote, under a per-fill token, in that
 * isolated world. Main later asks about that field, not about whatever happens to look
 * like a password field, so hiding it, switching it to plain text or detaching it does
 * not count as the password being gone. A new document has a fresh world without the
 * record: that is how Main learns the original document no longer exists.
 */
export type LoginFillOutcome =
  /** Username and password are in the form; nothing was submitted. */
  | { status: "filled" }
  | { status: "submitted" }
  /** First page of a two-step login: only the account name could be entered. */
  | { status: "username_only"; submitted: boolean }
  | { status: "no_login_form"; reason: LoginFillRefusal };

export type LoginFillRefusal = "no_password_field" | "several_password_fields" | "signup_or_reset";

/** What Main sees of the filled field. `replaced`: the document that received the password is gone. */
export type LoginFillFieldState =
  | { document: "replaced"; formVisible: boolean }
  | { document: "same"; formVisible: boolean; pending: boolean; fieldShown: boolean };

type FillRecord = { token: string; fields: HTMLInputElement[] };

function fillLogin(token: string, username: string, password: string, submit: boolean): LoginFillOutcome {
  const visible = (element: Element): element is HTMLInputElement => {
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const inputs = (root: ParentNode) => Array.from(root.querySelectorAll("input")).filter(visible);
  const isIdentifier = (input: HTMLInputElement) => ["text", "email", "tel", ""].includes(input.type);
  const looksLikeIdentifier = (input: HTMLInputElement) =>
    /username|email|tel/u.test(input.autocomplete) || input.type === "email"
    || /user|login|account|email|phone|mobile|identifier/iu.test(`${input.name} ${input.id}`);

  // Frameworks listen for input events and ignore a bare property write.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const type = (input: HTMLInputElement, value: string) => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const clickable = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || (element as HTMLButtonElement).disabled) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  };
  const submitButton = (form: HTMLFormElement) =>
    Array.from(form.querySelectorAll("button[type=submit], input[type=submit], button:not([type])")).find(clickable) as HTMLElement | undefined;
  const label = (element: Element | undefined) => element ? (element.textContent || (element as HTMLInputElement).value || "") : "";
  const loginButton = () => {
    const pattern = /^\s*(log\s*in|sign\s*in|continue|next|\u767b\u5f55|\u767b\u5165|\u767b \u5f55|\u4e0b\u4e00\u6b65|\u7ee7\u7eed)\s*$/iu;
    return Array.from(document.querySelectorAll("button, [role=button], input[type=button]"))
      .filter(clickable).find(element => pattern.test(label(element))) as HTMLElement | undefined;
  };
  const submitFrom = (field: HTMLInputElement) => {
    const form = field.form;
    if (form) {
      const button = submitButton(form);
      if (button) button.click(); else form.requestSubmit();
      return true;
    }
    // No form element: only a button that plainly says "log in" (English or Chinese) is safe to press.
    const button = loginButton();
    if (!button) return false;
    button.click();
    return true;
  };
  // Creating an account or setting a new password must never receive a saved password.
  const signupOrReset = (field: HTMLInputElement) => {
    if (/new-password/u.test(field.autocomplete)) return true;
    if (field.type === "password" && /new|confirm|repeat|retype|register|signup|reset/iu.test(`${field.name} ${field.id}`)) return true;
    const form = field.form;
    const context = form
      ? `${form.id} ${form.name} ${form.getAttribute("action") ?? ""} ${label(submitButton(form))}`
      : label(loginButton());
    return /register|sign[\s_-]*up|create[\s_-]*(an[\s_-]*)?account|join|reset|forgot|recover|\u6ce8\u518c|\u91cd\u7f6e|\u627e\u56de|\u521b\u5efa/iu.test(context);
  };

  const passwords = inputs(document).filter(input => input.type === "password");
  if (passwords.length > 1) return { status: "no_login_form", reason: "several_password_fields" };
  if (passwords.length === 0) {
    // Only a field that is plainly an account name: a lone search box must not receive one.
    const identifier = inputs(document).filter(isIdentifier).find(looksLikeIdentifier);
    if (!identifier) return { status: "no_login_form", reason: "no_password_field" };
    if (signupOrReset(identifier)) return { status: "no_login_form", reason: "signup_or_reset" };
    type(identifier, username);
    return { status: "username_only", submitted: submit && submitFrom(identifier) };
  }
  const passwordField = passwords[0];
  if (signupOrReset(passwordField)) return { status: "no_login_form", reason: "signup_or_reset" };
  const candidates = inputs(passwordField.form ?? document).filter(isIdentifier);
  const before = candidates.filter(input => input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING);
  const identifier = candidates.find(input => /username|email/u.test(input.autocomplete)) ?? before[before.length - 1];

  // Remember the field before writing, so a failure halfway still leaves it to be erased.
  const record: FillRecord = { token, fields: [passwordField] };
  (globalThis as unknown as { __desktopLoginFill?: FillRecord }).__desktopLoginFill = record;
  // Leaving the page (including into the back/forward cache) erases the field; a form POST has already read it.
  addEventListener("pagehide", () => { for (const field of record.fields) setter.call(field, ""); }, { capture: true });

  if (identifier) type(identifier, username);
  type(passwordField, password);
  return submit && submitFrom(passwordField) ? { status: "submitted" } : { status: "filled" };
}

function visiblePasswordForm() {
  return Array.from(document.querySelectorAll("input[type=password]")).some(input => {
    const rect = input.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  });
}

function fillFieldState(token: string, formVisible: boolean): LoginFillFieldState {
  const record = (globalThis as unknown as { __desktopLoginFill?: FillRecord }).__desktopLoginFill;
  if (!record || record.token !== token) return { document: "replaced", formVisible };
  const shown = (field: HTMLInputElement) => {
    if (!field.isConnected) return false;
    const rect = field.getBoundingClientRect();
    const style = getComputedStyle(field);
    return rect.width >= 2 && rect.height >= 2 && style.visibility !== "hidden" && style.display !== "none";
  };
  return {
    document: "same",
    formVisible,
    // Whatever its type, visibility or place in the tree, the field Desktop wrote still holds a value.
    pending: record.fields.some(field => field.value !== ""),
    fieldShown: record.fields.some(shown)
  };
}

/** Empties the field Desktop wrote, wherever it is now, then reports what is left. */
function clearFill(token: string): LoginFillFieldState {
  const record = (globalThis as unknown as { __desktopLoginFill?: FillRecord }).__desktopLoginFill;
  if (!record || record.token !== token) return { document: "replaced", formVisible: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const field of record.fields) {
    if (field.value === "") continue;
    setter.call(field, "");
    if (field.isConnected) {
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  return { document: "same", formVisible: false, pending: record.fields.some(field => field.value !== ""), fieldShown: false };
}

export const buildLoginFillScript = (input: { token: string; username: string; password: string; submit: boolean }) =>
  `(${fillLogin.toString()})(${JSON.stringify(input.token)}, ${JSON.stringify(input.username)}, ${JSON.stringify(input.password)}, ${JSON.stringify(input.submit)})`;
export const buildLoginFillStateScript = (token: string) =>
  `(${fillFieldState.toString()})(${JSON.stringify(token)}, (${visiblePasswordForm.toString()})())`;
export const buildLoginFillClearScript = (token: string) => `(${clearFill.toString()})(${JSON.stringify(token)})`;
