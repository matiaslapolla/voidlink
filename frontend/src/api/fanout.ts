/// Transport for the fan-out supervisor. Rust owns run and leg lifecycle
/// (`src-tauri/src/fanout/mod.rs` — read its header for why); this module only
/// moves records and events across the boundary, the same split `api/agent.ts`
/// makes against `commands/agent.ts` and `api/journal.ts` makes against
/// `store/journal.ts`.
///
/// Nothing here decides what a run *is* or reconciles it against what a window
/// already believes — that is `store/fanout.ts`.

import { Channel, invoke } from "@tauri-apps/api/core";

/// A leg's status, mirroring Rust's `fanout::LegStatus`. Deliberately has no
/// `interrupted` member — Rust never assigns one; see `store/fanout.ts` for
/// where that value comes from instead.
export type SupervisedLegStatus =
  | "pending"
  | "preparing"
  | "running"
  | "finished"
  | "failed"
  | "cancelled";

export interface LegSnapshot {
  id: string;
  agentId: string;
  agentName: string;
  commandTemplate: string;
  worktreePath: string;
  branch: string;
  status: SupervisedLegStatus;
  startedAt: number | null;
  endedAt: number | null;
  /// The full answer buffered so far — see the module header on
  /// `fanout::mod.rs` for why this is never truncated.
  answer: string;
  error: string | null;
}

export interface RunSnapshot {
  id: string;
  repo: string;
  legs: LegSnapshot[];
}

/// One leg as `fanout_start_run` needs it: ids, branch and worktree path
/// already minted by the caller (`legBranchName`/`legWorktreePath` in
/// `store/fanout.ts`), plus the fully assembled per-leg instruction.
export interface LegLaunchSpec {
  id: string;
  agentId: string;
  agentName: string;
  commandTemplate: string;
  branch: string;
  worktreePath: string;
  prompt: string;
}

export interface StartRunInput {
  runId: string;
  repo: string;
  prompt: string;
  legs: LegLaunchSpec[];
  secretBindings: { id: string; envVar: string }[];
}

/// One message on a run's subscription channel. `snapshot` arrives exactly
/// once, immediately after `subscribe` resolves, and carries every leg's full
/// state including its buffered answer — see `fanout::FanoutEvent` for why
/// this is a replay and not a "catch up on what you missed" delta.
export type FanoutStreamEvent =
  | { event: "snapshot"; data: { run: RunSnapshot } }
  | { event: "chunk"; data: { legId: string; text: string } }
  | { event: "legStatus"; data: { leg: LegSnapshot } };

export const fanoutApi = {
  /// Register a run and hand every leg to the supervisor. Resolves once the
  /// run is registered — **not** once every leg finishes. Legs run in the
  /// background, driven by Rust, independent of this call's caller ever
  /// awaiting anything again.
  startRun(input: StartRunInput): Promise<RunSnapshot> {
    return invoke<RunSnapshot>("fanout_start_run", {
      runId: input.runId,
      repo: input.repo,
      prompt: input.prompt,
      legs: input.legs,
      secretBindings: input.secretBindings,
    });
  },

  /// Cancel one leg. `false` means there was nothing to cancel — the leg had
  /// already reached a terminal status, which is an ordinary race and not a
  /// caller error.
  cancelLeg(legId: string): Promise<boolean> {
    return invoke<boolean>("fanout_cancel_leg", { legId });
  },

  /// What the supervisor is tracking for this repository right now. The
  /// reconnect entry point: called once per repo on mount, before trusting
  /// any locally-persisted run's status.
  runState(repo: string): Promise<RunSnapshot[]> {
    return invoke<RunSnapshot[]>("fanout_run_state", { repo });
  },

  /// Attach to a run's live output. `onEvent` receives the full buffered
  /// state once (as `snapshot`) and every chunk/status change from then on.
  /// Rejects when the supervisor has no record of `runId` — a caller must
  /// read that the same way as the run's absence from `runState`: not
  /// supervised, not "about to catch up".
  subscribe(runId: string, onEvent: (event: FanoutStreamEvent) => void): Promise<void> {
    const channel = new Channel<FanoutStreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("fanout_subscribe", { runId, onEvent: channel });
  },
};
