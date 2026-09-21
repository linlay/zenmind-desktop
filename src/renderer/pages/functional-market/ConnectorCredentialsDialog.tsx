import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import type { MarketConnectorTokenSchema } from "@shared/contracts/market-connector-state";
import { useI18n } from "../../i18n/useI18n";
import { connectorAuthorizationUrl } from "./connectorFlow";

export function ConnectorCredentialsDialog({ connectorName, schema, busy, error, onSubmit, onCancel }: { connectorName: string; schema: MarketConnectorTokenSchema | null; busy: boolean; error?: string; onSubmit: (credentials: Record<string, string>) => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { setValues(Object.fromEntries(schema?.fields.map(field => [field.key, field.type === "text" ? field.defaultValue || "" : ""]) || [])); }, [schema]);
  const valid = !!schema && schema.fields.length > 0 && schema.fields.every(field => /^(?:[A-Z][A-Z0-9_]*)$/.test(field.key) && ["text", "password"].includes(field.type) && typeof field.required === "boolean" && !(field.type === "password" && field.defaultValue !== undefined));
  const docs = connectorAuthorizationUrl(schema?.docUrl);
  return <Modal open={!!schema} centered title={t("market.connector.flow.credentialsTitle", { name: connectorName })} footer={null} maskClosable={false} onCancel={onCancel} destroyOnClose>
    {!valid ? <Alert type="error" message={t("market.connector.flow.invalidSchema")} /> : <form autoComplete="off" className="connector-token-form" onSubmit={event => { event.preventDefault(); if (busy || !valid) return; void onSubmit(values).finally(() => setValues({})); }}>
      <p>{t("market.connector.flow.credentialsHint")}</p>
      {schema?.title && <strong>{schema.title}</strong>}
      {schema?.description && <p>{schema.description}</p>}
      {docs && <Button type="link" onClick={() => void window.electronAPI.shell.openExternal(docs)}>{schema?.docLabel || t("market.connector.flow.documentation")}</Button>}
      {schema?.fields.map(field => <label className="connector-token-field" key={field.key}><span>{field.label || field.key}{field.required ? " *" : ""}</span>
        <Input type={field.type} autoComplete="off" maxLength={65536} required={field.required} disabled={busy} placeholder={field.placeholder} value={values[field.key] || ""}
          onChange={event => setValues(previous => ({ ...previous, [field.key]: event.target.value }))} />
        {field.description && <small>{field.description}</small>}
      </label>)}
      {error && <Alert type="error" showIcon message={error} />}
      <div className="connector-detail-actions"><Button onClick={onCancel}>{t("market.connector.flow.cancel")}</Button><Button htmlType="submit" type="primary" loading={busy} disabled={!valid}>{t("market.connector.flow.saveCredentials")}</Button></div>
    </form>}
  </Modal>;
}
