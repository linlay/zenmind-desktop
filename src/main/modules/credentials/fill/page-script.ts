/**
 * Fills a login form from an isolated JavaScript world of a guest page (the same world
 * as the login observer). The script text carries the password, so it is built and
 * executed in Main only and never logged.
 */
export type LoginFillOutcome =
  /** Username and password are in the form; nothing was submitted. */
  | { status: "filled" }
  | { status: "submitted" }
  /** First page of a two-step login: only the account name could be entered. */
  | { status: "username_only"; submitted: boolean }
  | { status: "no_login_form"; reason: "no_password_field" | "several_password_fields" };

function fillLogin(username: string, password: string, submit: boolean): LoginFillOutcome {
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
  const submitFrom = (field: HTMLInputElement) => {
    const form = field.form;
    if (form) {
      const button = Array.from(form.querySelectorAll("button[type=submit], input[type=submit], button:not([type])")).find(clickable);
      if (button) button.click(); else form.requestSubmit();
      return true;
    }
    // No form element: only a button that plainly says "log in" (English or Chinese) is safe to press.
    const label = /^\s*(log\s*in|sign\s*in|continue|next|\u767b\u5f55|\u767b\u5165|\u767b \u5f55|\u4e0b\u4e00\u6b65|\u7ee7\u7eed)\s*$/iu;
    const button = Array.from(document.querySelectorAll("button, [role=button], input[type=button]"))
      .filter(clickable).find(element => label.test(element.textContent || (element as HTMLInputElement).value || ""));
    if (!button) return false;
    button.click();
    return true;
  };

  const passwords = inputs(document).filter(input => input.type === "password");
  if (passwords.length > 1) return { status: "no_login_form", reason: "several_password_fields" };
  if (passwords.length === 0) {
    // Only a field that is plainly an account name: a lone search box must not receive one.
    const identifier = inputs(document).filter(isIdentifier).find(looksLikeIdentifier);
    if (!identifier) return { status: "no_login_form", reason: "no_password_field" };
    type(identifier, username);
    return { status: "username_only", submitted: submit && submitFrom(identifier) };
  }
  const passwordField = passwords[0];
  const candidates = inputs(passwordField.form ?? document).filter(isIdentifier);
  const before = candidates.filter(input => input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING);
  const identifier = candidates.find(input => /username|email/u.test(input.autocomplete)) ?? before[before.length - 1];
  if (identifier) type(identifier, username);
  type(passwordField, password);
  return submit && submitFrom(passwordField) ? { status: "submitted" } : { status: "filled" };
}

/** Whether a password field is still on screen, and whether one still holds a value. */
function passwordFieldState() {
  let visible = false;
  let pending = false;
  for (const input of Array.from(document.querySelectorAll("input[type=password]"))) {
    const field = input as HTMLInputElement;
    const rect = field.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    visible = true;
    if (field.value) pending = true;
  }
  return { visible, pending };
}

/** Empties every password field, including one switched to plain text by a "show password" control just before. */
function clearPasswords(password: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const input of Array.from(document.querySelectorAll("input"))) {
    if (input.type !== "password" && input.value !== password) continue;
    if (!input.value) continue;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

export const buildLoginFillScript = (input: { username: string; password: string; submit: boolean }) =>
  `(${fillLogin.toString()})(${JSON.stringify(input.username)}, ${JSON.stringify(input.password)}, ${JSON.stringify(input.submit)})`;
export const LOGIN_FILL_STATE_SCRIPT = `(${passwordFieldState.toString()})()`;
export const buildLoginFillClearScript = (password: string) => `(${clearPasswords.toString()})(${JSON.stringify(password)})`;
