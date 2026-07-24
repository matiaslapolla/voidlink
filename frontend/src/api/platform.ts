import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";

/// Host platform, resolved once at startup from the Rust side.
///
/// The value comes from `std::env::consts::OS` — the compiled target — not
/// from `navigator.userAgent`, which lies in a webview, and not from
/// `@tauri-apps/plugin-os`, which would be a whole plugin for one constant.
///
/// Consumers get a *synchronous* accessor: rendering an accelerator label
/// happens per row, per keystroke, and cannot await. `initPlatform()` is
/// awaited once in `main.tsx` before the first render, so by the time anything
/// reads `isMac()` the real answer is already in.

export type PlatformOs = "macos" | "linux" | "windows" | (string & {});

const [os, setOs] = createSignal<PlatformOs | null>(null);
let inflight: Promise<PlatformOs> | null = null;

/// Resolve and cache the host OS. Idempotent — concurrent callers share one
/// round trip, and later calls are free.
export function initPlatform(): Promise<PlatformOs> {
  const cached = os();
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = invoke<string>("platform_os")
    .then((value) => {
      setOs(value);
      return value as PlatformOs;
    })
    .catch(() => {
      // Running outside Tauri (a bare `vite dev`, a unit test) — assume the
      // primary target rather than blocking the UI on a failed IPC call.
      setOs("macos");
      return "macos" as PlatformOs;
    });
  return inflight;
}

/// The host OS. Reactive: reading it inside JSX re-renders if the value
/// arrives after first paint.
export function platformOs(): PlatformOs {
  return os() ?? "macos";
}

/// True on macOS. Drives ⌘/⌥/⇧/⌃ glyphs versus Ctrl/Alt/Shift words.
export function isMac(): boolean {
  return platformOs() === "macos";
}
