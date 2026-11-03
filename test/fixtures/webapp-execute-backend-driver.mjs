// Child fixture launched exactly as a managed electron-node backend; credentials never leave this process.
import { pathToFileURL } from 'node:url';

const { createBackendClient } = await import(pathToFileURL(process.env.WEBAPP_SMOKE_SDK));
const client = createBackendClient({ url: process.env.DESKTOP_ACTION_BRIDGE_URL, token: process.env.DESKTOP_ACTION_BRIDGE_TOKEN });
const controllers = new Map();
process.on('message', message => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return; }
  if (message.type !== 'execute') return;
  const controller = new AbortController(); controllers.set(message.id, controller);
  client.assistant.execute({ message: 'Managed backend smoke', input: message.input, outputSchema: { type: 'object' } }, { signal: controller.signal })
    .then(value => process.send?.({ id: message.id, value }), error => process.send?.({ id: message.id, code: error.code }))
    .finally(() => controllers.delete(message.id));
});
process.send?.({ id: 'ready', versions: { node: process.versions.node, electron: process.versions.electron } });
