import { WsClient, type WsClientOptions } from "@/features/transport/lib/wsClient";

let wsClient: WsClient | null = null;
let wsClientAccessToken = "";

export function initWsClient(options: WsClientOptions = {}): WsClient {
	const accessToken = String(options.accessToken || "").trim();
	const normalizedOptions: WsClientOptions = {
		...options,
		onAccessTokenChange: (token) => {
			wsClientAccessToken = String(token || "").trim();
			options.onAccessTokenChange?.(token);
		},
	};

	if (wsClient && wsClientAccessToken === accessToken) {
		wsClient.updateOptions(normalizedOptions);
		return wsClient;
	}

	if (wsClient) {
		wsClient.disconnect();
	}

	wsClient = new WsClient(normalizedOptions);
	wsClientAccessToken = accessToken;
	return wsClient;
}

export function getWsClient(): WsClient | null {
	return wsClient;
}

export function getWsClientAccessToken(): string {
	return wsClientAccessToken;
}

export function destroyWsClient(): void {
	if (wsClient) {
		wsClient.disconnect();
	}
	wsClient = null;
	wsClientAccessToken = "";
}
