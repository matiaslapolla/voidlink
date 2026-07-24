import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

/**
 * Which OS the app is running on, resolved once from the Rust side.
 *
 * Window chrome differs per platform: macOS uses the native title bar (rounded
 * corners, drop shadow, traffic lights drawn by the OS) while Windows and Linux
 * keep the custom title bar and resize overlay. Components need that answer
 * synchronously while rendering, so `initPlatform()` resolves it once at
 * startup and `isMac()` / `platformOs()` are plain accessors afterwards.
 *
 * The value comes from `std::env::consts::OS`, never from `navigator.userAgent`.
 */
export type PlatformOs = "macos" | "windows" | "linux" | "unknown";

const KNOWN: readonly PlatformOs[] = ["macos", "windows", "linux"];

const [os, setOs] = createSignal<PlatformOs>("unknown");

let pending: Promise<PlatformOs> | null = null;

/**
 * Resolve the platform once. Safe to call repeatedly — later calls reuse the
 * first request. Never rejects: outside a Tauri window (browser-only dev) it
 * settles on `"unknown"`, which falls back to the custom chrome.
 */
export function initPlatform(): Promise<PlatformOs> {
  pending ??= invoke<string>("get_platform_os")
    .then((value) =>
      (KNOWN as readonly string[]).includes(value) ? (value as PlatformOs) : "unknown",
    )
    .catch((): PlatformOs => "unknown")
    .then((value) => {
      setOs(value);
      return value;
    });
  return pending;
}

/** The resolved platform, or `"unknown"` until `initPlatform()` settles. */
export const platformOs = os;

/** True when running on macOS, where the OS draws the window chrome. */
export const isMac = () => os() === "macos";
