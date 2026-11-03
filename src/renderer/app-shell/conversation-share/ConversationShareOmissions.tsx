import type { ConversationShareOmittedResource } from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";

export function ConversationShareOmissions({ items, t }: {
  items: ConversationShareOmittedResource[];
  t: TranslateFunction;
}) {
  return (
    <div className="conversation-share-resource-summary" role="note">
      <p>{t("assistant.chatShareResourceScope")}</p>
      {items.length > 0 ? <>
        <p className="conversation-share-warning">{t("assistant.chatShareAttachmentsOmitted")}</p>
        <ul>{items.map((item, index) => (
          <li key={item.id ?? `${item.name}:${item.reason}:${index}`}>
            <span>{item.name}</span> — {t(`assistant.chatShareOmission.${item.reason}`)}
          </li>
        ))}</ul>
      </> : null}
    </div>
  );
}
