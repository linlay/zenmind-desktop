import { DownOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons";
import { Dropdown, Tooltip } from "antd";
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";

export const IMAGE_ZOOM_STEPS = [10, 25, 50, 75, 100, 125, 150, 200, 400, 800];

export function ImageZoomControl({ value, fit, disabled, onChange, onStep, onFit }: {
  value: number;
  fit: boolean;
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
        <button type="button" disabled={disabled || value <= 10} onClick={() => onStep(-1)} aria-label={t("chatWorkPanel.image.zoomOut")}><ZoomOutOutlined /></button>
      </Tooltip>
      <span className="work-panel-image-zoom-control">
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
        <span aria-hidden="true">%</span>
        <Dropdown
          trigger={["click"]}
          disabled={disabled}
          menu={{
            selectable: true,
            selectedKeys: [fit ? "fit" : String(value)],
            items: [
              { key: "fit", label: t("chatWorkPanel.image.fit") },
              { type: "divider" },
              ...IMAGE_ZOOM_STEPS.map((step) => ({ key: String(step), label: step === 100 ? t("chatWorkPanel.image.actualSize") : `${step}%` })),
            ],
            onClick: ({ key }) => { setDraft(null); if (key === "fit") onFit(); else onChange(Number(key)); },
          }}
        >
          <button type="button" className="work-panel-image-zoom-menu" disabled={disabled} aria-label={t("chatWorkPanel.image.zoomPresets")}><DownOutlined /></button>
        </Dropdown>
      </span>
      <Tooltip title={t("chatWorkPanel.image.zoomIn")}>
        <button type="button" disabled={disabled || value >= 800} onClick={() => onStep(1)} aria-label={t("chatWorkPanel.image.zoomIn")}><ZoomInOutlined /></button>
      </Tooltip>
    </div>
  );
}
