import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FsEntry } from "@/api/fs";

/// One alias from `~/.ssh/config`, as the host picker lists it.
export interface RemoteHost {
  alias: string;
  /// What the alias resolves to. Shown beside it so two aliases pointing at
  /// the same box are still tellable apart.
  hostname: string;
  user: string;
  port: number;
  /// Set when the alias needs a jump host. Listed anyway — an alias missing
  /// from the picker reads as a config problem — but refused at connect time,
  /// with that reason.
  proxyJump: string | null;
}

/// What a successful connect hands back. `sessionId` is the handle every
/// later call carries; `homeDir` is the absolute remote path the tree opens at.
export interface RemoteConnection {
  sessionId: string;
  homeDir: string;
  alias: string;
}

/// Fired with the session id when a connection dies on its own — a dropped
/// link, a rebooted host, a killed sshd. The tree marks that root dead rather
/// than letting the next click fail with a stat error.
const DISCONNECTED_EVENT = "remote://disconnected";

/// Paths in this API are the *remote* absolute paths, never the scheme-prefixed
/// ones the explorer passes around. `api/fsProvider.ts` owns that translation;
/// keeping it out of here means these wrappers stay a literal mirror of the
/// Rust command surface, exactly as `fsApi` is.
export const remoteApi = {
  hosts(): Promise<RemoteHost[]> {
    return invoke<RemoteHost[]>("remote_hosts");
  },

  connect(host: string): Promise<RemoteConnection> {
    return invoke<RemoteConnection>("remote_connect", { host });
  },

  listDir(sessionId: string, path: string): Promise<FsEntry[]> {
    return invoke<FsEntry[]>("remote_list_dir", { sessionId, path });
  },

  readFile(sessionId: string, path: string): Promise<string> {
    return invoke<string>("remote_read_file", { sessionId, path });
  },

  createFile(sessionId: string, path: string): Promise<void> {
    return invoke<void>("remote_create_file", { sessionId, path });
  },

  createDir(sessionId: string, path: string): Promise<void> {
    return invoke<void>("remote_create_dir", { sessionId, path });
  },

  rename(sessionId: string, from: string, to: string): Promise<void> {
    return invoke<void>("remote_rename", { sessionId, from, to });
  },

  delete(sessionId: string, path: string): Promise<void> {
    return invoke<void>("remote_delete", { sessionId, path });
  },

  copy(sessionId: string, from: string, to: string): Promise<void> {
    return invoke<void>("remote_copy", { sessionId, from, to });
  },

  disconnect(sessionId: string): Promise<void> {
    return invoke<void>("remote_disconnect", { sessionId });
  },

  onDisconnected(handler: (sessionId: string) => void): Promise<UnlistenFn> {
    return listen<string>(DISCONNECTED_EVENT, (e) => handler(e.payload));
  },
};
