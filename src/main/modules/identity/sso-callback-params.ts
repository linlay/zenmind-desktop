import { usedAuthorizationCodes, usedDesktopSsoTickets } from "./sso-state";

export function normalizeCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedCodes: Set<string> = usedAuthorizationCodes
) {
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!code) {
    throw new Error("missing authorization code");
  }
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  if (usedCodes.has(code)) {
    throw new Error("authorization code has already been used");
  }
  usedCodes.add(code);
  return { code, state };
}

export function normalizeDesktopTicketCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedTickets: Set<string> = usedDesktopSsoTickets
) {
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  const error = requestUrl.searchParams.get("error")?.trim() ?? "";
  if (error) {
    throw new Error(error);
  }
  const ticket = requestUrl.searchParams.get("ticket")?.trim() ?? "";
  if (!ticket) {
    throw new Error("missing desktop SSO ticket");
  }
  if (usedTickets.has(ticket)) {
    throw new Error("desktop SSO ticket has already been used");
  }
  usedTickets.add(ticket);
  return { ticket, state };
}
