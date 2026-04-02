import { invoke } from "@tauri-apps/api/core";

export interface ProviderSettings {
  activeProvider?: string;
  models: Record<string, string>;
}

export const settingsApi = {
  saveApiKey(provider: string, key: string): Promise<void> {
    return invoke("save_api_key", { provider, key });
  },

  loadApiKey(provider: string): Promise<string | null> {
    return invoke<string | null>("load_api_key", { provider });
  },

  saveProviderSettings(settings: ProviderSettings): Promise<void> {
    return invoke("save_provider_settings", { settings });
  },

  loadProviderSettings(): Promise<ProviderSettings> {
    return invoke<ProviderSettings>("load_provider_settings");
  },

  reloadProvider(): Promise<void> {
    return invoke("reload_provider");
  },
};
