import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import {
  Send,
  Loader,
  Bot,
  User,
  X,
  CheckCircle,
  AlertCircle,
  GitBranch,
  ExternalLink,
  FileText,
  ChevronRight,
} from "lucide-solid";
import { gitAgentApi } from "@/api/git-agent";
import { gitApi } from "@/api/git";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import type { AgentEvent, AgentTaskInput, AgentTaskState, DiffResult, FileDiff } from "@/types/git";

// ─── Chat message types ──────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  status?: "info" | "warn" | "error" | "success";
}

interface AgentChatViewProps {
  repoPath: string;
}

// ─── File preview panel types ────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Main component ──────────────────────────────────────────────────────────

export function AgentChatView(props: AgentChatViewProps) {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [taskId, setTaskId] = createSignal<string | null>(null);
  const [taskState, setTaskState] = createSignal<AgentTaskState | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [worktreeDiff, setWorktreeDiff] = createSignal<DiffResult | null>(null);
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [filesPanelWidth, setFilesPanelWidth] = createSignal(440);
  let messagesEnd!: HTMLDivElement;
  let seenEventIds = new Set<string>();

  const isRunning = () => {
    const s = taskState()?.status;
    return !!s && s !== "success" && s !== "failed";
  };

  const isTerminal = () => {
    const s = taskState()?.status;
    return s === "success" || s === "failed";
  };

  const hasChanges = () => {
    const diff = worktreeDiff();
    return diff && diff.files.length > 0;
  };

  // Scroll to bottom on new messages
  createEffect(() => {
    void messages().length;
    requestAnimationFrame(() => {
      messagesEnd?.scrollIntoView({ behavior: "smooth" });
    });
  });

  // Add a chat message
  const addMessage = (role: ChatMessage["role"], content: string, status?: ChatMessage["status"]) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role, content, timestamp: Date.now(), status },
    ]);
  };

  // ─── Agent lifecycle ─────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input().trim();
    if (!text) return;
    setInput("");

    addMessage("user", text);

    // If no task running, start one
    if (!taskId()) {
      setStarting(true);
      addMessage("system", "Starting agent...");
      try {
        const taskInput: AgentTaskInput = {
          repoPath: props.repoPath,
          objective: text,
          constraints: [],
          autoPr: false,
          githubBaseBranch: "main",
        };
        const id = await gitAgentApi.start(taskInput);
        setTaskId(id);
        const initial = await gitAgentApi.status(id);
        setTaskState(initial);
        addMessage("assistant", "Agent started. I'm working on your request...", "info");
      } catch (e) {
        addMessage("system", `Failed to start agent: ${e}`, "error");
      } finally {
        setStarting(false);
      }
    }
  };

  // Listen for agent events
  createEffect(() => {
    const id = taskId();
    if (!id) return;

    let unlisten: (() => void) | null = null;
    listen<AgentEvent>(`git-agent-event:${id}`, (evt) => {
      const ev = evt.payload;
      if (seenEventIds.has(ev.id)) return;
      seenEventIds.add(ev.id);

      setTaskState((prev) => {
        if (!prev) return prev;
        return { ...prev, events: [...prev.events, ev] };
      });

      addMessage(
        "assistant",
        ev.message,
        ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "info",
      );
    }).then((fn) => {
      unlisten = fn;
    });

    // Poll status
    const pollId = window.setInterval(async () => {
      try {
        const state = await gitAgentApi.status(id);
        setTaskState(state);

        // Sync any events we missed
        for (const ev of state.events) {
          if (seenEventIds.has(ev.id)) continue;
          seenEventIds.add(ev.id);
          addMessage(
            "assistant",
            ev.message,
            ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "info",
          );
        }

        // Terminal status messages
        if (state.status === "success" && !seenEventIds.has("__done")) {
          seenEventIds.add("__done");
          addMessage("assistant", "Task completed successfully!", "success");
        }
        if (state.status === "failed" && !seenEventIds.has("__fail")) {
          seenEventIds.add("__fail");
          addMessage("assistant", state.error ?? "Task failed.", "error");
        }
      } catch {}
    }, 2000);

    onCleanup(() => {
      unlisten?.();
      window.clearInterval(pollId);
    });
  });

  // Poll worktree diff when agent is running
  createEffect(() => {
    const state = taskState();
    if (!state?.worktreePath) {
      setWorktreeDiff(null);
      return;
    }
    const wtPath = state.worktreePath;

    const fetchDiff = () => {
      void gitApi.diffWorking(wtPath).then(setWorktreeDiff).catch(() => {});
    };
    fetchDiff();
    const id = setInterval(fetchDiff, 3000);
    onCleanup(() => clearInterval(id));
  });

  const handleCancel = async () => {
    const id = taskId();
    if (!id) return;
    try {
      await gitAgentApi.cancel(id);
      addMessage("system", "Agent cancelled.");
    } catch (e) {
      addMessage("system", `Cancel failed: ${e}`, "error");
    }
  };

  const handleNewChat = () => {
    setTaskId(null);
    setTaskState(null);
    setMessages([]);
    setWorktreeDiff(null);
    setSelectedFile(null);
    seenEventIds = new Set();
  };

  const handleFilesPanelResize = (delta: number) => {
    setFilesPanelWidth((w) => Math.max(280, Math.min(800, w - delta)));
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div class="flex h-full overflow-hidden">
      {/* ── Chat column ──────────────────────────────────────────────────── */}
      <div class="flex-1 flex flex-col min-w-0">
        {/* Status bar */}
        <Show when={taskState()}>
          {(state) => (
            <div class="flex items-center gap-2 px-4 py-2 border-b border-border bg-background/60 flex-shrink-0">
              <Show when={isRunning()}>
                <Loader class="w-4 h-4 text-primary animate-spin" />
              </Show>
              <Show when={state().status === "success"}>
                <CheckCircle class="w-4 h-4 text-success" />
              </Show>
              <Show when={state().status === "failed"}>
                <AlertCircle class="w-4 h-4 text-destructive" />
              </Show>
              <span class="text-xs font-medium capitalize">{state().status}</span>
              <Show when={state().currentStep}>
                <span class="text-xs text-muted-foreground">— {state().currentStep}</span>
              </Show>
              <Show when={state().branchName}>
                <div class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch class="w-3 h-3" />
                  <span class="font-mono">{state().branchName}</span>
                </div>
              </Show>
              <Show when={state().prUrl}>
                <a
                  href={state().prUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  PR <ExternalLink class="w-3 h-3" />
                </a>
              </Show>
              <Show when={isRunning()}>
                <button
                  onClick={() => void handleCancel()}
                  class="ml-2 flex items-center gap-1 text-xs rounded border border-border px-2 py-0.5 hover:bg-accent/60"
                >
                  <X class="w-3 h-3" /> Cancel
                </button>
              </Show>
              <Show when={isTerminal()}>
                <button
                  onClick={handleNewChat}
                  class="ml-2 text-xs rounded border border-border px-2 py-0.5 hover:bg-accent/60"
                >
                  New chat
                </button>
              </Show>
            </div>
          )}
        </Show>

        {/* Messages */}
        <div class="flex-1 overflow-y-auto">
          <div class="max-w-2xl mx-auto px-4 py-6 space-y-4">
            <Show when={messages().length === 0}>
              <div class="flex flex-col items-center justify-center py-20 text-center">
                <div class="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Bot class="w-6 h-6 text-primary" />
                </div>
                <h3 class="text-sm font-semibold mb-1">AI Agent</h3>
                <p class="text-xs text-muted-foreground max-w-xs">
                  Describe what you want to implement. The agent will create a branch,
                  make changes, and optionally open a PR.
                </p>
              </div>
            </Show>

            <For each={messages()}>
              {(msg) => (
                <div
                  class={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <Show when={msg.role !== "user"}>
                    <div class={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      msg.role === "system" ? "bg-accent" : "bg-primary/10"
                    }`}>
                      <Bot class={`w-4 h-4 ${msg.role === "system" ? "text-muted-foreground" : "text-primary"}`} />
                    </div>
                  </Show>

                  <div
                    class={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-md"
                        : msg.role === "system"
                          ? "bg-accent/60 text-muted-foreground rounded-bl-md text-xs"
                          : msg.status === "error"
                            ? "bg-destructive/10 text-destructive border border-destructive/20 rounded-bl-md"
                            : msg.status === "success"
                              ? "bg-success/10 text-success border border-success/20 rounded-bl-md"
                              : msg.status === "warn"
                                ? "bg-warning/10 text-warning border border-warning/20 rounded-bl-md"
                                : "bg-card border border-border rounded-bl-md"
                    }`}
                  >
                    <p class="whitespace-pre-wrap break-words">{msg.content}</p>
                    <span class="block mt-1 text-xs opacity-50">{formatTime(msg.timestamp)}</span>
                  </div>

                  <Show when={msg.role === "user"}>
                    <div class="w-7 h-7 rounded-full bg-accent flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User class="w-4 h-4 text-foreground" />
                    </div>
                  </Show>
                </div>
              )}
            </For>

            {/* Typing indicator */}
            <Show when={isRunning()}>
              <div class="flex gap-3">
                <div class="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Bot class="w-4 h-4 text-primary" />
                </div>
                <div class="bg-card border border-border rounded-2xl rounded-bl-md px-4 py-3">
                  <div class="flex gap-1">
                    <span class="w-2 h-2 rounded-full bg-primary/50 animate-bounce [animation-delay:0ms]" />
                    <span class="w-2 h-2 rounded-full bg-primary/50 animate-bounce [animation-delay:150ms]" />
                    <span class="w-2 h-2 rounded-full bg-primary/50 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            </Show>

            <div ref={messagesEnd} />
          </div>
        </div>

        {/* Input bar */}
        <div class="border-t border-border p-4 bg-background/60 flex-shrink-0">
          <div class="max-w-2xl mx-auto">
            <div class="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:border-primary/50 transition-colors">
              <textarea
                value={input()}
                onInput={(e) => setInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={taskId() ? "Send a follow-up..." : "Describe what you want to build..."}
                rows={1}
                disabled={starting()}
                class="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-h-[36px] max-h-32 py-1.5 px-2"
                style={{ "field-sizing": "content" }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={!input().trim() || starting()}
                class="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-primary-foreground disabled:opacity-30 hover:bg-primary/90 transition-colors flex-shrink-0"
              >
                <Show when={starting()} fallback={<Send class="w-4 h-4" />}>
                  <Loader class="w-4 h-4 animate-spin" />
                </Show>
              </button>
            </div>
            <p class="text-xs text-muted-foreground/50 mt-1.5 text-center">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>

      {/* ── Files panel (appears when there are changes) ─────────────────── */}
      <Show when={hasChanges()}>
        <ResizeHandle direction="vertical" onResize={handleFilesPanelResize} />
        <div
          class="flex-shrink-0 border-l border-border flex flex-col overflow-hidden bg-background/40"
          style={{ width: `${filesPanelWidth()}px` }}
        >
          {/* Panel header */}
          <div class="px-3 py-2 border-b border-border bg-background/60 flex-shrink-0">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold">Modified Files</span>
              <span class="text-xs text-muted-foreground">
                {worktreeDiff()!.files.length} files ·{" "}
                <span class="text-success">+{worktreeDiff()!.totalAdditions}</span>{" "}
                <span class="text-destructive">-{worktreeDiff()!.totalDeletions}</span>
              </span>
            </div>
          </div>

          {/* File list + preview */}
          <div class="flex-1 overflow-y-auto">
            <For each={worktreeDiff()!.files}>
              {(file) => <FileCard file={file} expanded={selectedFile() === (file.newPath ?? file.oldPath)} onToggle={(path) => setSelectedFile((p) => (p === path ? null : path))} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ─── File card with inline diff ──────────────────────────────────────────────

function FileCard(props: { file: FileDiff; expanded: boolean; onToggle: (path: string) => void }) {
  const path = () => props.file.newPath ?? props.file.oldPath ?? "unknown";

  const statusColor = () => {
    switch (props.file.status) {
      case "added": return "text-success";
      case "deleted": return "text-destructive";
      default: return "text-info";
    }
  };

  return (
    <div class="border-b border-border/50">
      {/* File header */}
      <button
        onClick={() => props.onToggle(path())}
        class="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/30 transition-colors"
      >
        <ChevronRight
          class={`w-3 h-3 text-muted-foreground flex-shrink-0 ${
            props.expanded ? "rotate-90" : ""
          }`}
          style={{ transition: "transform 80ms var(--ease-out-expo)" }}
        />
        <FileText class={`w-3.5 h-3.5 flex-shrink-0 ${statusColor()}`} />
        <span class="text-xs font-mono truncate flex-1">{path()}</span>
        <span class="text-xs text-success flex-shrink-0">+{props.file.additions}</span>
        <span class="text-xs text-destructive flex-shrink-0">-{props.file.deletions}</span>
      </button>

      {/* Inline diff */}
      <Show when={props.expanded && !props.file.isBinary}>
        <div class="bg-background/60 border-t border-border/30 overflow-x-auto">
          <For each={props.file.hunks}>
            {(hunk) => (
              <div>
                <div class="px-3 py-1 text-xs text-info/70 bg-info/5 font-mono">
                  {hunk.header}
                </div>
                <table class="w-full border-collapse font-mono text-xs">
                  <tbody>
                    <For each={hunk.lines}>
                      {(line) => (
                        <tr
                          class={
                            line.origin === "+"
                              ? "bg-success/8"
                              : line.origin === "-"
                                ? "bg-destructive/8"
                                : ""
                          }
                        >
                          <td class="w-8 px-2 text-right text-muted-foreground/40 select-none border-r border-border/20 tabular-nums">
                            {line.oldLineno ?? ""}
                          </td>
                          <td class="w-8 px-2 text-right text-muted-foreground/40 select-none border-r border-border/20 tabular-nums">
                            {line.newLineno ?? ""}
                          </td>
                          <td class="px-3 py-px whitespace-pre-wrap break-all">
                            <span
                              class={`select-none mr-1.5 ${
                                line.origin === "+"
                                  ? "text-success/60"
                                  : line.origin === "-"
                                    ? "text-destructive/60"
                                    : "text-muted-foreground/20"
                              }`}
                            >
                              {line.origin === "~" ? "\\" : line.origin}
                            </span>
                            <span
                              class={
                                line.origin === "+"
                                  ? "text-success/90"
                                  : line.origin === "-"
                                    ? "text-destructive/90"
                                    : "text-foreground/80"
                              }
                            >
                              {line.content}
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.expanded && props.file.isBinary}>
        <div class="px-3 py-2 text-xs text-muted-foreground italic">Binary file</div>
      </Show>
    </div>
  );
}
