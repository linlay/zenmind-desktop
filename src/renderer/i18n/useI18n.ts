import { useContext } from "react";
import { RendererI18nContext } from "./i18n-context";

export function useI18n() {
  return useContext(RendererI18nContext);
}
