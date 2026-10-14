import { useEffect, useState } from "react";
import type { WebsiteCredentialSaveDecision, WebsiteCredentialSaveOffer } from "../../shared/website-credentials";
import { useI18n } from "../i18n/useI18n";
import "./WebsiteCredentialSavePrompt.css";

/**
 * Asks whether to save a login Desktop just observed in a web page. It shows the site
 * and account as resolved by Main; the password never reaches this window.
 */
export function WebsiteCredentialSavePrompt() {
  const { t } = useI18n();
  const [offers, setOffers] = useState<WebsiteCredentialSaveOffer[]>([]);
  useEffect(() => window.electronAPI.settings.onWebsiteCredentialSaveOffer(event => {
    setOffers(current => event.type === "offer"
      ? [...current.filter(item => item.offerId !== event.offer.offerId), event.offer]
      : current.filter(item => item.offerId !== event.offerId));
  }), []);
  function answer(offerId: string, decision: WebsiteCredentialSaveDecision) {
    setOffers(current => current.filter(item => item.offerId !== offerId));
    void window.electronAPI.settings.resolveWebsiteCredentialSaveOffer({ offerId, decision }).catch(() => false);
  }
  if (!offers.length) return null;
  return <div className="website-credential-save-prompts">
    {offers.map(offer => <section key={offer.offerId} className="website-credential-save-prompt" role="alertdialog" aria-label={t("credentials.savePrompt.title.save")}>
      <strong>{t(offer.kind === "update" ? "credentials.savePrompt.title.update" : "credentials.savePrompt.title.save")}</strong>
      <dl>
        <dt>{t("settings.websiteCredentials.site")}</dt><dd>{offer.origin}</dd>
        <dt>{t("settings.websiteCredentials.username")}</dt><dd>{offer.username}</dd>
      </dl>
      {!offer.verified && <p>{t("credentials.savePrompt.unverified")}</p>}
      <div className="website-credential-save-prompt-actions">
        <button type="button" onClick={() => answer(offer.offerId, "never")}>{t("credentials.savePrompt.never")}</button>
        <button type="button" onClick={() => answer(offer.offerId, "dismiss")}>{t("credentials.savePrompt.dismiss")}</button>
        <button type="button" className="is-primary" onClick={() => answer(offer.offerId, "save")}>{t(offer.kind === "update" ? "credentials.savePrompt.update" : "credentials.savePrompt.save")}</button>
      </div>
    </section>)}
  </div>;
}
