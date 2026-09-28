import { createDesktopSkinStore } from "./appearance-store";

type SkinStore = ReturnType<typeof createDesktopSkinStore>;

// IPC and public actions share this queue, including reads and native pickers.
export function createAppearanceRuntime(createStore: () => SkinStore, onChanged: () => void = () => {}) {
  let store: SkinStore | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  return {
    run<T>(operation: (store: SkinStore) => T | Promise<T>, changed: boolean | ((value: T) => boolean) = false): Promise<T> {
      const result = operations.then(async () => {
        const value = await operation(store ??= createStore());
        if (typeof changed === "function" ? changed(value) : changed) {
          // A notification failure cannot turn an already committed write into a failure.
          try { onChanged(); } catch { /* The next renderer load reads canonical state. */ }
        }
        return value;
      });
      operations = result.catch(() => undefined);
      return result;
    }
  };
}

export type AppearanceRuntime = ReturnType<typeof createAppearanceRuntime>;
