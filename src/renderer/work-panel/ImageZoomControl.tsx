import { MinusOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";

export const IMAGE_ZOOM_STEPS = [10, 25, 50, 75, 100, 125, 150, 200, 400, 800];

export function ImageZoomControl({ value, disabled, onChange, onStep, onFit }: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onStep: (direction: -1 | 1) => void;
  onFit: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && /^\d+(?:\.\d+)?%?$/.test(draft.trim())) {
      onChange(Number(draft.trim().replace(/%$/, "")));
    }
    setDraft(null);
  };

  return (
    <div className="work-panel-image-zoom-group" role="group" aria-label={t("chatWorkPanel.image.zoom")}>
      <Tooltip title={t("chatWorkPanel.image.zoomOut")}>
        <button type="button" className="work-panel-image-zoom-step" disabled={disabled || value <= 10} onClick={() => onStep(-1)} aria-label={t("chatWorkPanel.image.zoomOut")}><MinusOutlined /></button>
      </Tooltip>
      <label className="work-panel-image-zoom-control">
        <input
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={draft ?? String(Math.round(value))}
          aria-label={t("chatWorkPanel.image.zoom")}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
          }}
        />
        <span className="work-panel-image-zoom-unit" aria-hidden="true">%</span>
      </label>
      <Tooltip title={t("chatWorkPanel.image.zoomIn")}>
        <button type="button" className="work-panel-image-zoom-step" disabled={disabled || value >= 800} onClick={() => onStep(1)} aria-label={t("chatWorkPanel.image.zoomIn")}><PlusOutlined /></button>
      </Tooltip>
      <span className="work-panel-image-zoom-divider" aria-hidden="true" />
      <Tooltip title={t("chatWorkPanel.image.fit")}>
        <button type="button" className="work-panel-image-zoom-reset" disabled={disabled} onClick={onFit} aria-label={t("chatWorkPanel.image.fit")}><ReloadOutlined /></button>
      </Tooltip>
    </div>
  );
}
