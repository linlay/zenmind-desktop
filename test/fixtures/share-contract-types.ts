import type {
  ShareEnvelope, ShareHandoff, ShareRecord, ShareReceiveRequest,
} from "../../src/shared/contracts/shares";
import type { ShareRecordWire } from "../../src/main/modules/shares/http-contract";
import { SHARE_PROTOCOL_VERSION } from "../../src/shared/contracts/shares";

const conversation = {
  protocolVersion: SHARE_PROTOCOL_VERSION,
  kind: "conversation",
  title: "Frozen conversation",
  content: { version: 1, data: { version: 1, messages: [], attachments: [] } },
  resources: [],
  preview: { type: "builtin", viewer: "conversation" },
} satisfies ShareEnvelope;

const market = {
  ...conversation,
  kind: "market-resource",
  preview: undefined,
  desktop: {
    receiverId: "builtin.market", contextVersion: 2,
    context: { itemId: "connector_1", resourceVersion: "1.2.3" },
  },
} satisfies ShareEnvelope;

const preview = {
  ...conversation,
  kind: "static-report",
  content: { version: 3, resourceId: "0123456789abcdef01234567" },
  preview: { type: "package", entrypoint: "index.html" },
  resources: [{
    id: "0123456789abcdef01234567", name: "index.html", mimeType: "text/html",
    size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", path: "index.html",
  }],
} satisfies ShareEnvelope;

const service = {
  ...conversation,
  kind: "webapp-service", preview: undefined,
  service: { type: "webapp", webAppId: "webapp_1" },
} satisfies ShareEnvelope;

// @ts-expect-error Access policies have no place in the new envelope.
const expiring: ShareEnvelope = { ...conversation, expiresAt: null };
// @ts-expect-error One-time access is retired.
const once: ShareEnvelope = { ...conversation, singleUse: true };
// @ts-expect-error Only a registered receiver's numeric protocol version is used.
const badContextVersion: ShareHandoff = { ...market.desktop, contextVersion: "1.2.3" };
// @ts-expect-error File content and JSON content cannot both be supplied.
const twoContents: ShareEnvelope = { ...conversation, content: { version: 1, data: {}, resourceId: "file" } };
// @ts-expect-error The new model cannot invent a conversation identity.
const fakeConversation: ShareEnvelope = { ...market, conversationId: "fake" };
// @ts-expect-error Online bindings cannot inject arbitrary proxy targets.
const arbitraryService: ShareEnvelope = { ...service, service: { type: "url", url: "https://example.test" } };
// @ts-expect-error Receiver contexts cannot contain functions or executable actions.
const executable: ShareHandoff = { ...market.desktop, context: { callback: () => {} } };

declare const wire: ShareRecordWire;
// @ts-expect-error HTTP time strings must be decoded before crossing IPC.
const rendererRecord: ShareRecord = wire;
const receive: ShareReceiveRequest = { ...market.desktop, shareId: "share_1", intentId: "intent_1" };
void [preview, service, receive, expiring, once, badContextVersion, twoContents, fakeConversation, arbitraryService, executable, rendererRecord];
