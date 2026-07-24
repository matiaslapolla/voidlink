import { invoke } from "@tauri-apps/api/core";

/// What the frontend is allowed to know about a stored provider key.
///
/// There is deliberately no `get` here and no `secret_get` command in Rust:
/// values live in the OS keychain, are read only by the Rust spawn site that
/// injects them into the AI subprocess, and never cross back over IPC.
export interface SecretStatus {
  id: string;
  present: boolean;
  /// At most the last 4 characters of the stored value — empty for short
  /// values. Never the value itself.
  hint: string;
}

export const secretsApi = {
  /// Store `value` in the OS keychain under `id`. `envVar` is validated (POSIX
  /// name shape, not a shell/loader variable) but not persisted by Rust — the
  /// mapping lives in the settings store.
  ///
  /// Rejects rather than resolves when the keychain is locked or the user
  /// denies the OS prompt, so callers must surface the error.
  set(id: string, envVar: string, value: string): Promise<void> {
    return invoke<void>("secret_set", { id, envVar, value });
  },

  /// Remove the keychain entry for `id`. Already-absent counts as success.
  delete(id: string): Promise<void> {
    return invoke<void>("secret_delete", { id });
  },

  /// Presence + masked hint for each id, in the order requested.
  status(ids: string[]): Promise<SecretStatus[]> {
    return invoke<SecretStatus[]>("secret_status", { ids });
  },
};
