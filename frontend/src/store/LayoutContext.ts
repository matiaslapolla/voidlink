import { createContext, useContext } from "solid-js";
import type { LayoutStoreState, LayoutStoreActions } from "./layout";

export const LayoutContext = createContext<
  readonly [LayoutStoreState, LayoutStoreActions]
>();

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within LayoutContext.Provider");
  return ctx;
}
