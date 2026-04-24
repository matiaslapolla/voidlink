import { createContext, useContext } from "solid-js";
import type { AppStore } from "./layout";

export const AppStoreContext = createContext<AppStore>();

export function useAppStore(): AppStore {
  const ctx = useContext(AppStoreContext);
  if (!ctx) throw new Error("useAppStore must be used inside AppStoreContext.Provider");
  return ctx;
}
