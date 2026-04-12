import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-solid";
import { agentRunnerApi } from "@/api/agent-runner";
import { gitApi } from "@/api/git";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { DiffViewer } from "@/components/git/DiffViewer";
import type { AgentSessionInfo, AgentTool, StartSessionInput } from "@/types/agent-runner";
import type { DiffResult } from "@/types/git";

interface AgentOrchestratorViewProps {
  repoPath: string;
}

// Maps detect-result binary names → AgentTool values
const BIN_TO_TOOL: Record<string, AgentTool> = {
  claude: "claudeCode",
  codex: "codex",
  opencode: "openCode",
};

function toolLabel(tool: AgentTool): string {
  switch (tool) {
    case "claudeCode": return "Claude Code";
    case "codex":      return "Codex";
    case "openCode":   return "OpenCode";
  }
}

function StatusDot(props: { status: string }) {
  const cls = () => {
    switch (props.status) {
      case "running":  return "bg-success";
      case "starting": return "bg-warning animate-pulse";
      case "done":     return "bg-muted-foreground";
      case "failed":   return "bg-destructive";
      default:         return "bg-muted-foreground";
    }
  };
  return <span class={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${cls()}`} />;
}

export function AgentOrchestratorView(props: AgentOrchestratorViewProps) {
  const [sessions, setSessions] = createSignal<AgentSessionInfo[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [availableTools, setAvailableTools] = createSignal<string[]>([]);
  const [showLauncher, setShowLauncher] = createSignal(false);
  const [diffExpanded, setDiffExpanded] = createSignal(false);
  const [worktreeDiff, setWorktreeDiff] = createSignal<DiffResult | null>(null);
  const [attentionIds, setAttentionIds] = createSignal<Set<string>>(new Set());

  // Launcher form
  const [branchInput, setBranchInput] = createSignal("");
  const [launching, setLaunching] = createSignal(false);
  const [launchError, setLaunchError] = createSignal<string | null>(null);

  const selectedSession = createMemo(
    () => sessions().find((s) => s.sessionId === selectedId()) ?? null,
  );

  const refreshSessions = () => {
    void agentRunnerApi.listSessions().then(setSessions).catch(() => {});
  };

  onMount(() => {
    void agentRunnerApi.detectTools().then(setAvailableTools);

    refreshSessions();
    const interval = setInterval(refreshSessions, 3000);

    const unlisteners: (() => void)[] = [];

    listen("agent:status-changed", () => refreshSessions()).then((fn) => unlisteners.push(fn));

    listen<string>("agent:needs-attention", (e) => {
      setAttentionIds((prev) => new Set([...prev, e.payload]));
    }).then((fn) => unlisteners.push(fn));

    listen<string>("agent:active", (e) => {
      setAttentionIds((prev) => {
        const next = new Set(prev);
        next.delete(e.payload);
        return next;
      });
    }).then((fn) => unlisteners.push(fn));

    onCleanup(() => {
      clearInterval(interval);
      unlisteners.forEach((fn) => fn());
    });
  });

  // Poll live diff when session is selected and panel is open
  createEffect(() => {
    const session = selectedSession();
    if (!session || !diffExpanded()) {
      setWorktreeDiff(null);
      return;
    }
    const fetchDiff = () => {
      void gitApi
        .diffWorking(session.worktreePath)
        .then(setWorktreeDiff)
        .catch(() => {});
    };
    fetchDiff();
    const id = setInterval(fetchDiff, 5000);
    onCleanup(() => clearInterval(id));
  });

  const handleLaunch = async (bin: string) => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const input: StartSessionInput = {
        repoPath: props.repoPath,
        tool: BIN_TO_TOOL[bin] ?? "claudeCode",
        branchName: branchInput().trim() || undefined,
      };
      const session = await agentRunnerApi.startSession(input);
      setSessions((prev) => [session, ...prev]);
      setSelectedId(session.sessionId);
      setShowLauncher(false);
      setBranchInput("");
    } catch (e) {
      setLaunchError(String(e));
    } finally {
      setLaunching(false);
    }
  };

  const handleKill = (sessionId: string) => {
    void agentRunnerApi.killSession(sessionId).then(refreshSessions).catch(() => {});
  };

  const handleCleanup = (sessionId: string) => {
    void agentRunnerApi.cleanupSession(sessionId).then(() => {
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      if (selectedId() === sessionId) setSelectedId(null);
      setAttentionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }).catch(() => {});
  };

  return (
    <div class="flex h-full overflow-hidden">
      {/* ── Left panel: session list ────────────────────────────────────────── */}
      <div class="w-52 flex-shrink-0 border-r border-border flex flex-col">
        <div class="p-2 border-b border-border">
          <button
            onClick={() => {
              setShowLauncher((v) => !v);
              setLaunchError(null);
            }}
            class="w-full flex items-center justify-center gap-1.5 text-xs rounded px-2 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus class="w-3.5 h-3.5" />
            New Agent
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Show when={sessions().length === 0}>
            <p class="text-xs text-muted-foreground p-3 leading-relaxed">
              No sessions yet. Launch an agent to get started.
            </p>
          </Show>

          <For each={sessions()}>
            {(session) => (
              <button
                onClick={() => setSelectedId(session.sessionId)}
                class={`w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors border-b border-border/50 ${
                  selectedId() === session.sessionId
                    ? "bg-accent/70"
                    : "hover:bg-accent/40"
                }`}
              >
                <div class="relative flex-shrink-0 mt-0.5">
                  <StatusDot status={session.status} />
                  <Show when={attentionIds().has(session.sessionId)}>
                    <span
                      class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning animate-pulse"
                      title="Waiting for input"
                    />
                  </Show>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-medium">{toolLabel(session.tool)}</div>
                  <div class="text-xs text-muted-foreground font-mono truncate mt-0.5">
                    {session.worktreeName}
                  </div>
                </div>
                <Show
                  when={session.status === "running" || session.status === "starting"}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleKill(session.sessionId);
                    }}
                    title="Kill session"
                    class="p-0.5 rounded opacity-50 hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-colors"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────────── */}
      <div class="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Launcher form */}
        <Show when={showLauncher()}>
          <div class="border-b border-border p-3 space-y-2.5 bg-background/60 shrink-0">
            <Show
              when={availableTools().length > 0}
              fallback={
                <p class="text-xs text-warning">
                  No CLI agents found in PATH. Install{" "}
                  <code class="font-mono">claude</code>,{" "}
                  <code class="font-mono">codex</code>, or{" "}
                  <code class="font-mono">opencode</code>.
                </p>
              }
            >
              <input
                value={branchInput()}
                onInput={(e) => setBranchInput(e.currentTarget.value)}
                placeholder="Branch name (optional)"
                class="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary/60"
              />

              <p class="text-xs text-muted-foreground">
                Pick a tool — the terminal opens with the command pre-filled so you can add flags or just hit Enter.
              </p>

              <div class="flex gap-1.5 flex-wrap">
                <For each={availableTools()}>
                  {(bin) => (
                    <button
                      onClick={() => void handleLaunch(bin)}
                      disabled={launching()}
                      class="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent/60 disabled:opacity-50 transition-colors font-mono"
                    >
                      {bin}
                    </button>
                  )}
                </For>
              </div>

              <Show when={launchError()}>
                <p class="text-xs text-destructive">{launchError()}</p>
              </Show>

              <button
                onClick={() => { setShowLauncher(false); setLaunchError(null); }}
                class="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </Show>
          </div>
        </Show>

        {/* Session view or empty state */}
        <Show
          when={selectedSession()}
          fallback={
            <div class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              {sessions().length === 0
                ? "Launch an agent to get started."
                : "Select a session from the left."}
            </div>
          }
        >
          {(session) => (
            <>
              {/* Session header */}
              <div class="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-background/60 shrink-0">
                <StatusDot status={session().status} />
                <span class="text-xs font-medium">{toolLabel(session().tool)}</span>
                <span class="text-xs text-muted-foreground font-mono truncate">
                  {session().worktreeName}
                </span>
                <span
                  class={`ml-auto text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                    session().status === "running"
                      ? "bg-success/10 text-success"
                      : session().status === "done"
                        ? "bg-muted text-muted-foreground"
                        : session().status === "failed"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-warning/10 text-warning"
                  }`}
                >
                  {session().status}
                </span>
                <Show when={session().status === "done" || session().status === "failed"}>
                  <button
                    onClick={() => handleCleanup(session().sessionId)}
                    title="Remove worktree and close session"
                    class="shrink-0 text-xs px-2 py-0.5 rounded border border-border hover:bg-destructive/10 hover:border-destructive/40 hover:text-destructive transition-colors"
                  >
                    Clean up
                  </button>
                </Show>
              </div>

              {/* Attention banner */}
              <Show when={attentionIds().has(session().sessionId)}>
                <div class="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/20 text-warning text-xs shrink-0">
                  <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
                  Agent is waiting — switch to the terminal and respond.
                </div>
              </Show>

              {/* Terminal — takes all remaining space above the diff toggle */}
              <div class="flex-1 overflow-hidden" style={{ "min-height": "0" }}>
                <TerminalPane ptyId={session().ptyId} class="w-full h-full" />
              </div>

              {/* Diff toggle button */}
              <button
                onClick={() => setDiffExpanded((v) => !v)}
                class="flex items-center gap-1.5 w-full px-3 py-1.5 border-t border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors bg-background/40 shrink-0"
              >
                <Show
                  when={diffExpanded()}
                  fallback={<ChevronUp class="w-3 h-3" />}
                >
                  <ChevronDown class="w-3 h-3" />
                </Show>
                Live diff
                <span class="font-mono opacity-60 ml-1">{session().worktreeName}</span>
              </button>

              {/* Live diff panel */}
              <Show when={diffExpanded()}>
                <div class="h-60 border-t border-border overflow-y-auto shrink-0">
                  <Show
                    when={worktreeDiff()}
                    fallback={
                      <p class="text-xs text-muted-foreground p-3">
                        No changes yet — the agent hasn't modified any files.
                      </p>
                    }
                  >
                    {(diff) => <DiffViewer diff={diff()} />}
                  </Show>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
