import { useEffect, useState } from "react";
import { Button, Collapse, Modal, Steps, Typography } from "antd";
import { useI18n } from "../../i18n/useI18n";

export function ChromeConnectionGuide({ open, busy, onClose, onOpenExtension, onPaste, afterClose, isMac, isWindows }: {
  isMac: boolean; isWindows: boolean; open: boolean; busy: boolean; onClose(): void; onOpenExtension(): void; onPaste(): void; afterClose(): void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  useEffect(() => { if (open) setStep(0); }, [open]);
  return <Modal title={t("settings.browser.guide")} open={open} onCancel={onClose} afterClose={afterClose}
    width={620} className="browser-connection-guide" footer={<>
      {step > 0 && <Button onClick={() => setStep(step - 1)}>{t("settings.browser.guideBack")}</Button>}
      {step < 2 ? <Button type="primary" onClick={() => setStep(step + 1)}>{t(step === 0 ? "settings.browser.guideInstalled" : "settings.browser.guideCopied")}</Button>
        : <Button type="primary" onClick={onPaste}>{t("settings.browser.guidePaste")}</Button>}
    </>}>
    <Steps size="small" current={step} items={[
      { title: t("settings.browser.guideInstall") }, { title: t("settings.browser.guideToken") }, { title: t("settings.browser.guideSave") },
    ]} />
    <div className="browser-guide-step" key={step}>
      {step === 0 && <>
        <p>{t("settings.browser.guideInstallIntro")}</p>
        <ol>
          <li>{t("settings.browser.guideAddress")}<div className="browser-guide-address"><Typography.Text copyable>chrome://extensions</Typography.Text></div></li>
          <li>{t("settings.browser.guideFolder")}<Button size="small" disabled={busy} onClick={onOpenExtension}>{t("browserUse.install")}</Button></li>
          <li>{t("settings.browser.guideLoad")} {isMac && t("settings.browser.guideChooseMac")} {isWindows && t("settings.browser.guideChooseWindows")}</li>
        </ol>
        <p className="browser-guide-hint">{t("settings.browser.guideAlreadyInstalled")}</p>
      </>}
      {step === 1 && <>
        <ol>
          <li>{t("settings.browser.guideOpenStatus")}<div className="browser-guide-address"><Typography.Text copyable>chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html</Typography.Text></div></li>
          <li>{t("settings.browser.guideFindCode")}<div className="browser-guide-example"><code>PLAYWRIGHT_MCP_EXTENSION_TOKEN=…</code></div></li>
          <li>{t("settings.browser.guideCopyCode")}</li>
        </ol>
        <Collapse ghost className="browser-guide-troubleshooting" items={[{ key: "status", label: t("settings.browser.guideTrouble"), children: <p>{t("settings.browser.guideStatusTrouble")}</p> }]} />
      </>}
      {step === 2 && <>
        <ol>
          <li>{t("settings.browser.guidePasteCode")}</li>
          <li>{t(isMac ? "settings.browser.guideKeychain" : "settings.browser.guideEncryption")}</li>
          <li>{t("settings.browser.guideSuccess")}</li>
        </ol>
        <p className="browser-guide-hint">{t("settings.browser.guideTryTask")}</p>
      </>}
    </div>
  </Modal>;
}
