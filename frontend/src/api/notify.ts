/// Transport for the notification policy. Rust owns the policy itself
/// (`src-tauri/src/notify/mod.rs` — read its header for why); this module only
/// moves settings and visibility across the boundary.
///
/// There is no `send()` here, and there never should be. Notifications are
/// dispatched by Rust as a policy over the event log, so the frontend's entire
/// role is to answer two questions Rust cannot: what the user has configured,
/// and what they are currently looking at.

import { invoke } from "@tauri-apps/api/core";

/// How loudly one event family may interrupt. Mirrors Rust's `Level`.
export type NotifyLevel = "silent" | "sound" | "banner" | "both";

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ["silent", "sound", "banner", "both"];

/// One row of the matrix. `prefix` is matched against an event `kind` with
/// `startsWith`, and the longest match wins — so `agent.turn.failed` overrides
/// `agent.` without the list having to be in any particular order.
export interface NotifyRule {
  prefix: string;
  level: NotifyLevel;
}

export interface NotifyConfig {
  muted: boolean;
  /// `[start, end)` in hours. Wraps midnight when `start > end`. `null` for no
  /// quiet hours.
  quietHours: [number, number] | null;
  rules: NotifyRule[];
  coalesceMs: number;
  volume: number;
  /// `"default"` or `"silent"`. An unknown name falls back to the default pack
  /// rather than to silence — see `sound.rs`.
  pack: string;
}

export const notifyApi = {
  config(): Promise<NotifyConfig> {
    return invoke<NotifyConfig>("notify_config", {});
  },

  setConfig(config: NotifyConfig): Promise<void> {
    return invoke<void>("notify_set_config", { config });
  },

  /// Play the attention cue at the current volume and pack. Goes through the
  /// same path a real cue does, so the preview cannot be louder or quieter than
  /// the thing it is previewing.
  testCue(): Promise<void> {
    return invoke<void>("notify_test_cue", {});
  },

  /// Tell Rust what is on screen, so it can suppress a banner for something the
  /// user is already watching.
  ///
  /// Repositories rather than tab ids: an event carries a repo, and doing the
  /// join here rather than in Rust keeps the tab→repo mapping in the one store
  /// that owns it.
  setVisible(repos: string[], focused: boolean): Promise<void> {
    return invoke<void>("notify_visible", { repos, focused });
  },
};
