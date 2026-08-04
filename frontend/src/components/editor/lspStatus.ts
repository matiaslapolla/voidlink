/// The language-server status seam.
///
/// Wave 5 builds the actual LSP bridge. This module is the contract it will
/// report *through*, landed early on purpose: the status vocabulary is a design
/// decision (five states, one of which is "render nothing"), and deciding it
/// alongside the bridge is how it would end up as a permanent grey chip that
/// nags every user who does not want a language server.
///
/// Nothing in here spawns, reads or knows about a process. The only writer is
/// `setLspStatus`, which Wave 5's client calls; everything else derives.
///
/// The five states, from `.claude/prompts/editor-100x.md`'s `<design>`:
///
/// | State       | LED                | Segment text            | On click    |
/// |-------------|--------------------|-------------------------|-------------|
/// | absent      | none — no segment  | —                       | —           |
/// | starting    | `--warning` pulsing| `rust-analyzer starting`| output log  |
/// | ready       | `--success` solid  | `rust-analyzer`         | output log  |
/// | degraded    | `--warning` solid  | `rust-analyzer degraded`| output log  |
/// | crashed     | `--destructive`    | `rust-analyzer stopped` | restart     |
///
/// "Absent binary degrades to today's behavior" means the segment is *absent*.
/// A crash, by contrast, is unexpected, so it persists until acknowledged
/// rather than clearing on focus (§7.5.3, the `failed` row).

import { createSignal } from "solid-js";
import type { ActivitySignal } from "@/components/layout/activitySignal";

export type LspState = "absent" | "starting" | "ready" | "degraded" | "crashed";

export interface LspStatus {
  state: LspState;
  /// Binary name as the user would type it — `rust-analyzer`, not a path.
  /// Empty while `absent`, which is the only state with no server to name.
  server: string;
  /// Consecutive crashes. Wave 5 toasts once at three (`<design>`); below that
  /// a crash-restart cycle is ambient only.
  crashes: number;
}

export const NO_LSP: LspStatus = { state: "absent", server: "", crashes: 0 };

const [lspStatus, setStatus] = createSignal<LspStatus>(NO_LSP);
export { lspStatus };

/// The seam Wave 5's client calls. Keeps the crash counter, because that is
/// the one piece of state a stateless "here is the current status" report
/// cannot carry and the toast rule needs.
export function setLspStatus(next: { state: LspState; server?: string }) {
  setStatus((prev) => nextStatus(prev, next));
}

/// Pure transition, split out so the counter is testable without a signal.
export function nextStatus(
  prev: LspStatus,
  next: { state: LspState; server?: string },
): LspStatus {
  const server = next.server ?? prev.server;
  if (next.state === "absent") return NO_LSP;
  return {
    state: next.state,
    server,
    // A crash increments; reaching `ready` again is what resets, so three
    // crashes with a successful start between them is not a crash loop.
    crashes:
      next.state === "crashed"
        ? prev.crashes + 1
        : next.state === "ready"
          ? 0
          : prev.crashes,
  };
}

/// Whether the crash at `status` is the one that earns a toast. Exactly at
/// three, never again — `<design>`: "do not toast on every crash-restart
/// cycle, but do toast once if it crashes three times in a row".
export function shouldToastCrash(status: LspStatus): boolean {
  return status.state === "crashed" && status.crashes === 3;
}

/// Clear a crash. Called by the segment's own click (which restarts) — a crash
/// never clears on focus alone (§7.5.3).
export function acknowledgeLspCrash() {
  setStatus((prev) => (prev.state === "crashed" ? { ...prev, state: "starting" } : prev));
}

/// What the status segment renders. `null` means draw nothing at all, which is
/// the whole point of the `absent` state.
export interface LspSegment {
  signal: ActivitySignal;
  /// The LED's hollow, pulsing form (§7.5.3 rule 4). Only `starting` uses it:
  /// warning-pulsing and warning-solid must differ without motion, because
  /// `prefers-reduced-motion` removes the pulse.
  pending: boolean;
  text: string;
  /// What clicking does, as a verb the tooltip can use.
  action: "log" | "restart";
  title: string;
}

export function lspSegment(status: LspStatus): LspSegment | null {
  switch (status.state) {
    case "absent":
      return null;
    case "starting":
      return {
        signal: "running",
        pending: true,
        text: `${status.server} starting`,
        action: "log",
        title: `${status.server} is starting — click to show its output log`,
      };
    case "ready":
      return {
        signal: "finished",
        pending: false,
        text: status.server,
        action: "log",
        title: `${status.server} is running — click to show its output log`,
      };
    // `dirty` is the vocabulary's warning-*solid* mark (§7.5.3 row 1: filled
    // dot, `--warning`, no glow, no pulse). The signal names for a closed set
    // of *marks*, not for a closed set of meanings — `running` is the only
    // pulsing member and would say "starting" here. The LED is rendered
    // `silent` in the segment, so nothing announces "unsaved changes"; the
    // segment's own text is the accessible name.
    case "degraded":
      return {
        signal: "dirty",
        pending: false,
        text: `${status.server} degraded`,
        action: "log",
        title: `${status.server} is up but requests are failing — click to show its output log`,
      };
    case "crashed":
      return {
        signal: "failed",
        pending: false,
        text: `${status.server} stopped`,
        action: "restart",
        title: `${status.server} stopped unexpectedly — click to restart it`,
      };
  }
}
