import { useState } from "react";
import { Alert, Checkbox, Input, Modal } from "antd";
import {
  DESKTOP_CONFIRMABLE_ACTIONS,
  normalizeDesktopActionConfirmationExemptActions
} from "../../../shared/desktop-action-confirmation";
import { useI18n } from "../../i18n/useI18n";
import { actionConfirmationLabels, actionConfirmationCategoryLabels } from "./desktopActionConfirmationLabels";
import "./DesktopActionConfirmationSettingsDialog.css";

export function DesktopActionConfirmationSettingsDialog({
  exemptActions,
  confirmationEnabled,
  onSave,
  onClose
}: {
  exemptActions: string[];
  confirmationEnabled: boolean;
  onSave: (actions: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(() => new Set<string>(normalizeDesktopActionConfirmationExemptActions(exemptActions)));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const groups = new Map<string, typeof DESKTOP_CONFIRMABLE_ACTIONS>();
  for (const action of DESKTOP_CONFIRMABLE_ACTIONS) {
    const label = t(actionConfirmationLabels[action.name]);
    const category = t(actionConfirmationCategoryLabels[action.category]);
    if (query && !`${label} ${category} ${action.name}`.toLocaleLowerCase().includes(query)) continue;
    const items = groups.get(action.category) ?? [];
    items.push(action);
    groups.set(action.category, items);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(normalizeDesktopActionConfirmationExemptActions([...selected]));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      centered
      width={680}
      className="desktop-action-settings-dialog"
      title={t("settings.actionConfirmation.title")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      keyboard={!saving}
      maskClosable={!saving}
      onOk={() => void save()}
      onCancel={onClose}
    >
      <div className="desktop-action-settings-content">
        <p className="desktop-action-settings-description">{t("settings.actionConfirmation.description")}</p>
        {!confirmationEnabled ? (
          <Alert type="info" showIcon message={t("settings.actionConfirmation.globallyDisabled")} />
        ) : null}
        <Input
          allowClear
          value={search}
          placeholder={t("settings.actionConfirmation.search")}
          aria-label={t("settings.actionConfirmation.search")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="desktop-action-settings-toolbar">
          <Checkbox
            checked={selected.size === DESKTOP_CONFIRMABLE_ACTIONS.length}
            indeterminate={selected.size > 0 && selected.size < DESKTOP_CONFIRMABLE_ACTIONS.length}
            disabled={saving}
            onChange={(event) => setSelected(new Set(event.target.checked ? DESKTOP_CONFIRMABLE_ACTIONS.map(({ name }) => name) : []))}
          >
            {t("settings.actionConfirmation.exemptAll")}
          </Checkbox>
          <span aria-live="polite">{t("settings.actionConfirmation.count", { count: selected.size, total: DESKTOP_CONFIRMABLE_ACTIONS.length })}</span>
        </div>
        <div className="desktop-action-settings-list">
          {[...groups].map(([category, actions]) => (
            <section key={category} className="desktop-action-settings-group" aria-labelledby={`action-confirmation-${category}`}>
              <h3 id={`action-confirmation-${category}`}>{t(actionConfirmationCategoryLabels[actions[0].category])}</h3>
              {actions.map((action) => (
                <Checkbox
                  key={action.name}
                  className="desktop-action-settings-item"
                  checked={selected.has(action.name)}
                  disabled={saving}
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(action.name);
                    else next.delete(action.name);
                    return next;
                  })}
                >
                  {t(actionConfirmationLabels[action.name])}
                </Checkbox>
              ))}
            </section>
          ))}
          {groups.size === 0 ? <p className="desktop-action-settings-empty">{t("settings.actionConfirmation.noResults")}</p> : null}
        </div>
        <p className="desktop-action-settings-description">{t("settings.actionConfirmation.scopeHint")}</p>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </div>
    </Modal>
  );
}
