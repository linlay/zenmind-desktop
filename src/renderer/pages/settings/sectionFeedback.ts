import type { SettingsSectionId } from "../../../shared/settings-sections";

export type NoticeTone = "success" | "error";
export type SettingsNotice = {
  id: number;
  sectionId: SettingsSectionId;
  tone: NoticeTone;
  message: string;
};
export type SectionReadErrorMap = Partial<Record<SettingsSectionId, string>>;

export function createSectionNotice(id: number, sectionId: SettingsSectionId, message: string, tone: NoticeTone): SettingsNotice | null {
  return tone === "success" ? null : { id, sectionId, message, tone };
}

export function dismissSectionNoticeById(current: SettingsNotice | null, id: number) {
  return current?.id === id ? null : current;
}

export function selectSectionFeedback(sectionId: SettingsSectionId | null, notice: SettingsNotice | null, readErrors: SectionReadErrorMap) {
  return {
    notice: notice?.sectionId === sectionId && notice?.tone === "error" ? notice : null,
    readError: sectionId ? readErrors[sectionId] ?? "" : ""
  };
}
