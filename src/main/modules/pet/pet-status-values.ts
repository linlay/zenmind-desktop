import {
  normalizeDesktopPetWhitespaceText,
  DESKTOP_PET_STATUS_HINT_TEXTS,
  truncateDesktopPetReplyPreview,
  sanitizeDesktopPetUnreadCount
} from "../../../shared/desktop-pet";
import type { DesktopPetLocalStatus } from "./pet-model";

export function sanitizeDesktopPetMessagePreview(value: unknown) {
  const normalized = normalizeDesktopPetWhitespaceText(value);
  if (!normalized || DESKTOP_PET_STATUS_HINT_TEXTS.has(normalized)) {
    return "";
  }
  return truncateDesktopPetReplyPreview(normalized);
}

export function isGenericDesktopPetDoneHint(value: unknown) {
  const normalized = normalizeDesktopPetWhitespaceText(value);
  return !normalized || DESKTOP_PET_STATUS_HINT_TEXTS.has(normalized);
}

export function createDefaultDesktopPetLocalStatus(settings?: { unreadCount?: unknown }): DesktopPetLocalStatus {
  return {
    status: "idle",
    hint: "",
    unreadCount: sanitizeDesktopPetUnreadCount(settings?.unreadCount),
    chatId: null
  };
}
