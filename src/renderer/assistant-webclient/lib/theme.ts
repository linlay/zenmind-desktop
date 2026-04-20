import {
	hasNativeAgentWebClientHost,
	resolveHostRootElement,
	resolveHostThemeMode,
} from "./host";

export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "agent-webclient.themeMode";
export const STATION_STORE_KEY = "STATION_STORE";

export function normalizeThemeMode(value: unknown): ThemeMode {
	return value === "dark" ? "dark" : "light";
}

export function readHostThemeMode(): ThemeMode | null {
	const nativeThemeMode = resolveHostThemeMode();
	if (nativeThemeMode) {
		return nativeThemeMode;
	}

	if (typeof window === "undefined") {
		return null;
	}

	try {
		const search = window.location?.search || "";
		if (!search) {
			return null;
		}
		const params = new URLSearchParams(search);
		const hostTheme = params.get("hostTheme");
		if (!hostTheme) {
			return null;
		}
		return normalizeThemeMode(hostTheme);
	} catch (_error) {
		return null;
	}
}

export function readStoredThemeMode(): ThemeMode | null {
	if (typeof localStorage === "undefined") {
		return null;
	}
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (!stored) {
			return readStationStoreThemeMode();
		}
		return normalizeThemeMode(stored);
	} catch (_error) {
		return null;
	}
}

export function readStationStoreThemeMode(): ThemeMode | null {
	if (typeof localStorage === "undefined") {
		return null;
	}
	try {
		const stored = localStorage.getItem(STATION_STORE_KEY);
		if (!stored) {
			return null;
		}
		const parsed = JSON.parse(stored) as { theme?: unknown } | null;
		if (!parsed || typeof parsed !== "object" || !parsed.theme) {
			return null;
		}
		return normalizeThemeMode(parsed.theme);
	} catch (_error) {
		return null;
	}
}

export function writeStationStoreThemeMode(themeMode: ThemeMode): void {
	if (typeof localStorage === "undefined") {
		return;
	}
	try {
		const stored = localStorage.getItem(STATION_STORE_KEY);
		const parsed = stored ? JSON.parse(stored) : {};
		const store =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed
				: {};
		localStorage.setItem(
			STATION_STORE_KEY,
			JSON.stringify({ ...store, theme: themeMode }),
		);
	} catch (_error) {
		try {
			localStorage.setItem(STATION_STORE_KEY, JSON.stringify({ theme: themeMode }));
		} catch (_innerError) {
			// Ignore storage write failures and keep the in-memory theme state.
		}
	}
}

export function writeStoredThemeMode(themeMode: ThemeMode): void {
	writeStationStoreThemeMode(themeMode);
	if (hasNativeAgentWebClientHost()) {
		return;
	}
	if (typeof localStorage === "undefined") {
		return;
	}
	try {
		localStorage.setItem(THEME_STORAGE_KEY, themeMode);
	} catch (_error) {
		// Ignore storage write failures and keep the in-memory theme state.
	}
}

export function applyThemeModeToDocument(themeMode: ThemeMode): void {
	const nativeRootElement = resolveHostRootElement();
	if (nativeRootElement) {
		nativeRootElement.setAttribute("data-theme", themeMode);
	}

	if (typeof document !== "undefined" && !nativeRootElement) {
		document.documentElement.setAttribute("data-theme", themeMode);
	}
}

export function resolveInitialThemeMode(): ThemeMode {
	const hostThemeMode = readHostThemeMode();
	if (hostThemeMode) {
		return hostThemeMode;
	}

	const storedThemeMode = readStoredThemeMode();
	if (storedThemeMode) {
		return storedThemeMode;
	}

	if (typeof document !== "undefined") {
		const attrThemeMode = document.documentElement.getAttribute("data-theme");
		if (attrThemeMode) {
			return normalizeThemeMode(attrThemeMode);
		}
	}

	return "light";
}
