import { createSignal } from "solid-js";
import { gitApi } from "@/api/git";
import type { DiffResult } from "@/types/git";

/// One source of repo state that was folded into the prompt. Surfaced under
/// each answer so the user can audit exactly what the model saw — the
/// "shared context bus, visible" idea from session-1.md Massive #1.
export interface AuditItem {
  label: string;
  detail: string;
}

export interface AgentMessage {
  role: "user" | "assistant" | "error";
  content: string;
  /// Audit trail attached to assistant/error turns (the context that fed it).
  audit?: AuditItem[];
  /// Round-trip time for assistant turns.
  ms?: number;
}

// Per-workspace conversation history. Kept in memory only — the agent is a
// scratch surface, not a persisted document.
const [threads, setThreads] = createSignal<Record<string, AgentMessage[]>>({});
const [busy, setBusy] = createSignal(false);
const [panelOpen, setPanelOpen] = createSignal(false);

export function agentThread(wtId: string): AgentMessage[] {
  return threads()[wtId] ?? [];
}
export function agentBusy() {
  return busy();
}
export function agentPanelOpen() {
  return panelOpen();
}
export function toggleAgentPanel(open?: boolean) {
  setPanelOpen((v) => (open === undefined ? !v : open));
}
export function clearAgentThread(wtId: string) {
  setThreads((t) => ({ ...t, [wtId]: [] }));
}

function pushMessage(wtId: string, msg: AgentMessage) {
  setThreads((t) => ({ ...t, [wtId]: [...(t[wtId] ?? []), msg] }));
}

/// Compact, capped unified-ish rendering of a diff for the prompt. We summarize
/// rather than dump — a model rarely needs more than the first slice of a large
/// diff, and an unbounded paste blows the CLI's context window.
function renderDiff(diff: DiffResult, maxChars: number): string {
  let out = "";
  for (const f of diff.files) {
    const path = f.newPath ?? f.oldPath ?? "(unknown)";
    out += `--- ${path} (${f.status}, +${f.additions} -${f.deletions})\n`;
    if (f.isBinary) {
      out += "[binary]\n";
      continue;
    }
    for (const h of f.hunks) {
      out += `${h.header}\n`;
      for (const l of h.lines) {
        const p = l.origin === "+" ? "+" : l.origin === "-" ? "-" : " ";
        out += `${p}${l.content}\n`;
      }
    }
    if (out.length > maxChars) {
      out = out.slice(0, maxChars) + "\n… [diff truncated]\n";
      break;
    }
  }
  return out;
}

interface AssembledContext {
  prompt: string;
  audit: AuditItem[];
}

/// Gather live workspace state through the same commands the UI renders from,
/// fold it into a single grounded prompt, and record an audit item per source.
/// `history` is the prior conversation (so a stateless CLI call still has
/// continuity); `openFiles`/`activePath` come from the layout store.
async function assembleContext(
  repoPath: string,
  question: string,
  history: AgentMessage[],
  openFiles: string[],
  activePath: string | null,
): Promise<AssembledContext> {
  const audit: AuditItem[] = [];
  const sections: string[] = [];

  sections.push(
    "You are VoidLink's repository assistant. Answer the user's question about THIS git repository using the live context below. Be concise and concrete — cite file paths, branch names, and commit SHAs. If the context is insufficient, say what command or file you'd need.",
  );

  try {
    const info = await gitApi.repoInfo(repoPath);
    const upstream = info.upstream
      ? ` (↑${info.ahead} ↓${info.behind} vs ${info.upstream})`
      : "";
    sections.push(
      `## Repository\nBranch: ${info.currentBranch ?? "(detached)"}${upstream}\nWorking tree: ${info.isClean ? "clean" : "dirty"}`,
    );
    audit.push({
      label: "Repository status",
      detail: `${info.currentBranch ?? "detached"}${upstream}, ${info.isClean ? "clean" : "dirty"}`,
    });
  } catch {
    /* skip block on failure */
  }

  try {
    const status = await gitApi.fileStatus(repoPath);
    if (status.length > 0) {
      const lines = status
        .slice(0, 50)
        .map((s) => `${s.staged ? "● " : "  "}${s.status.padEnd(9)} ${s.path}`)
        .join("\n");
      sections.push(`## Changed files (${status.length})\n${lines}`);
      audit.push({ label: "Changed files", detail: `${status.length}` });
    }
  } catch {
    /* skip */
  }

  try {
    const log = await gitApi.log(repoPath, undefined, 12);
    if (log.length > 0) {
      const lines = log
        .map((c) => `${c.oid.slice(0, 8)} ${c.summary}`)
        .join("\n");
      sections.push(`## Recent commits\n${lines}`);
      audit.push({ label: "Recent commits", detail: `${log.length}` });
    }
  } catch {
    /* skip */
  }

  try {
    const staged = await gitApi.diffWorking(repoPath, true);
    if (staged.files.length > 0) {
      sections.push(`## Staged diff\n${renderDiff(staged, 6000)}`);
      audit.push({
        label: "Staged diff",
        detail: `${staged.files.length} files, +${staged.totalAdditions} -${staged.totalDeletions}`,
      });
    }
  } catch {
    /* skip */
  }

  if (openFiles.length > 0) {
    const list = openFiles
      .map((p) => (p === activePath ? `${p} (active)` : p))
      .join(", ");
    sections.push(`## Open files\n${list}`);
    audit.push({ label: "Open files", detail: `${openFiles.length}` });
  }

  if (history.length > 0) {
    const convo = history
      .filter((m) => m.role !== "error")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    sections.push(`## Conversation so far\n${convo}`);
  }

  sections.push(`## Question\n${question}`);

  return { prompt: sections.join("\n\n"), audit };
}

/// Run one agent turn for the worktree `wtId`. Returns nothing — results land in the
/// thread via `pushMessage` so the panel re-renders reactively.
export async function askAgent(opts: {
  wtId: string;
  repoPath: string;
  commandTemplate: string;
  question: string;
  openFiles: string[];
  activePath: string | null;
}): Promise<void> {
  const q = opts.question.trim();
  if (!q || busy()) return;

  const history = agentThread(opts.wtId);
  pushMessage(opts.wtId, { role: "user", content: q });
  setBusy(true);
  const startedAt = performance.now();
  try {
    const { prompt, audit } = await assembleContext(
      opts.repoPath,
      q,
      history,
      opts.openFiles,
      opts.activePath,
    );
    const answer = await gitApi.agentQuery(opts.repoPath, opts.commandTemplate, prompt);
    pushMessage(opts.wtId, {
      role: "assistant",
      content: answer,
      audit,
      ms: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    pushMessage(opts.wtId, {
      role: "error",
      content: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - startedAt),
    });
  } finally {
    setBusy(false);
  }
}
