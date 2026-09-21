import { type DesktopActionCallRequest } from "../../../shared/desktop-actions";

export function normalizePermissionMode(value: unknown) {
  return value === "full_access" || value === "page_control" || value === "default"
    ? value
    : "";
}

export function readRequestPermissionMode(request: DesktopActionCallRequest, args: Record<string, unknown>) {
  return normalizePermissionMode(request.permissionMode) || normalizePermissionMode(args.permissionMode) || "default";
}
