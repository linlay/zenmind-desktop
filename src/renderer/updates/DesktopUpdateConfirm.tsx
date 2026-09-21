import { Modal } from "antd";
import { useI18n } from "../i18n/useI18n";

export function DesktopUpdateConfirm({ open, pending, canInstall, onConfirm, onCancel }: {
  open: boolean;
  pending: boolean;
  canInstall: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const dirty = open && Boolean(document.querySelector('[data-native-image-dirty="true"], [data-work-panel-document-dirty="true"], [data-webclient-document-dirty="true"]'));
  return <Modal centered open={open} title={t("updates.action")} okText={t("updates.confirmInstall")}
    cancelText={t("common.cancel")} confirmLoading={pending}
    okButtonProps={{ disabled: !canInstall }} cancelButtonProps={{ disabled: pending }}
    closable={!pending} maskClosable={!pending} keyboard={!pending}
    onOk={onConfirm} onCancel={() => { if (!pending) onCancel(); }}>
    <p>{t("updates.restartHint")}</p>
    {dirty ? <p role="alert">{t("updates.confirmDrafts")}</p> : null}
    {!canInstall ? <p>{t("updates.developmentHint")}</p> : null}
  </Modal>;
}
