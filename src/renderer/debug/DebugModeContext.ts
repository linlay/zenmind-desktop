import { createContext, useContext } from "react";

/**
 * Session-scoped renderer debug mode. It deliberately is not persisted: the
 * hidden settings unlock only applies to the currently running Desktop window.
 */
export const DebugModeContext = createContext(false);

export function useDebugMode() {
  return useContext(DebugModeContext);
}
