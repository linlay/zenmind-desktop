import {
	normalizeThemeMode,
	resolveInitialThemeMode,
	STATION_STORE_KEY,
	THEME_STORAGE_KEY,
	writeStoredThemeMode,
} from "./theme";

describe("theme helpers", () => {
	const originalWindow = globalThis.window;

	afterEach(() => {
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: originalWindow,
			});
		} else {
			delete (globalThis as Record<string, unknown>).window;
		}
	});

	it("normalizes unknown theme values to light", () => {
		expect(normalizeThemeMode("dark")).toBe("dark");
		expect(normalizeThemeMode("system")).toBe("light");
		expect(normalizeThemeMode(undefined)).toBe("light");
	});

	it("prefers the host theme query over the stored theme and html attribute", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: {
					search: "?desktopApp=1&hostTheme=dark",
				},
			},
		});
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) =>
					key === THEME_STORAGE_KEY ? "light" : null,
			},
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				documentElement: {
					getAttribute: () => "light",
				},
			},
		});

		expect(resolveInitialThemeMode()).toBe("dark");
	});

	it("falls back to the stored theme when no host theme is provided", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: {
					search: "?desktopApp=1",
				},
			},
		});
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) =>
					key === THEME_STORAGE_KEY ? "dark" : null,
			},
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				documentElement: {
					getAttribute: () => "light",
				},
			},
		});

		expect(resolveInitialThemeMode()).toBe("dark");
	});

	it("falls back to STATION_STORE when the webclient theme is not stored", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				location: {
					search: "?desktopApp=1",
				},
			},
		});
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) =>
					key === STATION_STORE_KEY ? '{"theme":"dark","avatar":"g.gif"}' : null,
			},
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				documentElement: {
					getAttribute: () => "light",
				},
			},
		});

		expect(resolveInitialThemeMode()).toBe("dark");
	});

	it("writes theme changes into STATION_STORE while preserving existing fields", () => {
		const values = new Map<string, string>([
			[STATION_STORE_KEY, '{"avatar":"g.gif","theme":"light","themeIndex":0}'],
		]);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => {
					values.set(key, value);
				},
			},
		});

		writeStoredThemeMode("dark");

		expect(JSON.parse(values.get(STATION_STORE_KEY) || "{}")).toEqual({
			avatar: "g.gif",
			theme: "dark",
			themeIndex: 0,
		});
	});
});
