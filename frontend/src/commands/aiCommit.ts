import { createSignal } from "solid-js";
import { gitApi } from "@/api/git";
import { pushToast } from "@/commands/toast";

/// Lifecycle of a single AI commit-message draft. We expose this as a
/// global signal so the palette, sidebar, and any future status-bar
/// indicator stay in sync without prop drilling.
export type DraftState =
  | { kind: "idle" }
  | { kind: "drafting"; startedAt: number; repoPath: string }
  | { kind: "success"; ms: number; repoPath: string; message: string }
  | { kind: "error"; ms: number; repoPath: string; reason: string };

const [draftState, setDraftState] = createSignal<DraftState>({ kind: "idle" });

export function aiCommitState() {
  return draftState();
}

export interface DraftResult {
  ok: boolean;
  message?: string;
  reason?: string;
  ms: number;
}

/// Drive the BYO-CLI backend with consistent UX: timing, friendly error
/// strings for the common "not on PATH" failure, and a single global
/// state signal so anything in the UI can render "drafting…" without
/// hand-rolling its own resource. `silent` skips the toast — callers
/// that surface inline feedback (the sidebar) opt out.
export async function draftCommitMessage(
  repoPath: string,
  commandTemplate: string,
  opts?: { silent?: boolean },
): Promise<DraftResult> {
  const cmd = commandTemplate.trim();
  if (!cmd) {
    if (!opts?.silent) {
      pushToast(
        "No AI command configured — open Settings → AI to add one",
        "warning",
        5000,
      );
    }
    return { ok: false, reason: "no-command", ms: 0 };
  }

  const startedAt = performance.now();
  setDraftState({ kind: "drafting", startedAt, repoPath });
  try {
    const message = await gitApi.aiGenerateCommit(repoPath, cmd);
    const ms = Math.round(performance.now() - startedAt);
    setDraftState({ kind: "success", ms, repoPath, message });
    if (!opts?.silent) {
      pushToast(`Drafted commit message in ${formatMs(ms)}`, "success", 2500);
    }
    return { ok: true, message, ms };
  } catch (e) {
    const ms = Math.round(performance.now() - startedAt);
    const reason = e instanceof Error ? e.message : String(e);
    setDraftState({ kind: "error", ms, repoPath, reason });
    if (!opts?.silent) {
      pushToast(`AI draft failed: ${friendlyReason(reason)}`, "error", 6000);
    }
    return { ok: false, reason, ms };
  }
}

export function resetDraftState() {
  setDraftState({ kind: "idle" });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/// Backend error strings carry the spawn-failure pattern verbatim from
/// std::process. Shorten the common case to something a user can act on.
function friendlyReason(reason: string): string {
  const spawn = reason.match(/failed to spawn `([^`]+)`/);
  if (spawn) return `${spawn[1]} not found on PATH — check Settings → AI`;
  if (reason.includes("No staged changes")) return "Stage some changes first";
  return reason.replace(/^"|"$/g, "").trim();
}

export const AI_COMMIT_REQUEST_EVENT = "voidlink:ai-draft-commit";

/// Ask whichever component owns the commit textarea (today: GitSidebar)
/// to start a draft. Decouples global triggers (palette, shortcut) from
/// the active view; the listener is responsible for inserting the
/// resulting message into its textarea.
export function requestAiCommitDraft() {
  window.dispatchEvent(new CustomEvent(AI_COMMIT_REQUEST_EVENT));
}
