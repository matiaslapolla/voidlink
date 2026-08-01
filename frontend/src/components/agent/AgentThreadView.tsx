import {
  For,
  Show,
  createMemo,
  createSignal,
  createEffect,
  type JSX,
} from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
} from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { StatusLed } from "@/components/layout/StatusLed";
import { agentById, resolveAgentCommand, useSettings } from "@/store/settings";
import {
  agentBusy,
  agentRetryable,
  agentThread,
  askAgent,
  cancelAgentTurn,
  clearAgentThread,
  retryAgentTurn,
  type AgentMessage,
} from "@/commands/agent";

/// The agent thread — one component, two renderers.
///
/// The slide-over (`AgentPanel`) and the agent tab body (`AgentPane`) both mount
/// this. That is the whole point of the slice: the slide-over stays for quick
/// questions, but as a second *renderer* over one store rather than a second
/// implementation. A forked copy of the bubble list, the markdown pipeline, the
/// audit disclosure and the composer is exactly the drift promoting the agent to
/// a tab kind exists to prevent.
///
/// What makes this the agent rather than a chat box is that every turn is
/// grounded in live workspace state — branch, status, log, staged diff, open
/// files — gathered through the same commands the UI renders from, with an
/// auditable trail of which sources fed each answer. The "Context used (N)"
/// disclosure is the product's trust story, not a debug affordance.
export interface AgentThreadViewProps {
  /// Which worktree's thread. Passed rather than read from the store so a
  /// renderer's scope is a fact about where it was mounted: an agent tab lives
  /// in one worktree's pane tree and can only ever show that worktree's
  /// conversation. The slide-over used to read the active worktree on every
  /// render, so switching worktrees with it open silently swapped the thread.
  wtId: string;
  /// The thread key — an agent tab's id, or `SLIDE_OVER_TAB_ID`.
  tabId: string;
  /// Which roster entry (`settings.ai.agents`) this thread talks to.
  agentId: string;
  onOpenSettings: () => void;
  /// The trailing slot of the header, for a renderer's own chrome — the
  /// slide-over's close button. The tab body leaves it empty; a tab already has
  /// a close affordance in the strip.
  headerActions?: JSX.Element;
}

export function AgentThreadView(props: AgentThreadViewProps) {
  const { activeRepoPath, activeOpenFiles, editorActiveItem } = useAppStore();
  const { settings } = useSettings();
  const [input, setInput] = createSignal("");
  let scroller: HTMLDivElement | undefined;

  const repoPath = () => activeRepoPath() ?? null;
  const entry = createMemo(() => {
    // Read through the reactive store so a roster rename or a template edit in
    // Settings lands on an open thread without a remount; `agentById` is the
    // non-reactive snapshot for the command layer.
    void settings.ai.agents;
    return agentById(props.agentId);
  });
  const agentName = () => entry()?.name.trim() || "Repo agent";
  const command = () => resolveAgentCommand(entry());
  const messages = createMemo(() => agentThread(props.wtId, props.tabId));
  const busy = () => agentBusy(props.wtId, props.tabId);
  const retryable = () => agentRetryable(props.wtId, props.tabId);

  /// The file the user is looking at, for grounding. Read from the *editor*
  /// window's pointer: files moved to that window, so the workbench's own
  /// pointer never names one and this would otherwise always be null.
  const activePath = () => {
    const a = editorActiveItem();
    return a && (a.type === "file" || a.type === "preview") ? a.path : null;
  };

  const grounding = () => ({
    wtId: props.wtId,
    tabId: props.tabId,
    repoPath: repoPath() ?? "",
    commandTemplate: command(),
    // For the event log's `actorName`. The roster name is what a cross-repo
    // view can group by; the command template is an implementation detail that
    // two differently-purposed agents can share.
    agentName: agentName(),
    openFiles: activeOpenFiles().map((f) => f.path),
    activePath: activePath(),
  });

  // Follow the newest message and the streaming tail. Reading the last message's
  // content is what keeps this firing per chunk rather than only per turn.
  createEffect(() => {
    const last = messages().at(-1);
    void last?.content;
    void busy();
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  async function send() {
    const repo = repoPath();
    const q = input().trim();
    if (!repo || !q || busy() || !command()) return;
    setInput("");
    await askAgent({ ...grounding(), repoPath: repo, question: q });
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="shrink-0 flex items-center gap-2 px-3 py-2">
        {/* The liveness channel for a turn in flight, and the *only* looping
            mark here. `pending` renders it hollow so it differs from a resting
            LED in fill as well as motion, and `motion-loop` keeps it animating
            under `prefers-reduced-motion` instead of freezing on its final
            keyframe (MASTER §7.4, §7.5.3 rule 4). Without both, a reduced-motion
            user loses the pending state entirely. */}
        <Show
          when={busy()}
          fallback={
            <StatusLed signal="idle" dim class="w-2 h-2" aria-label="agent idle" />
          }
        >
          <StatusLed signal="running" pending class="motion-loop" />
        </Show>
        <span class="text-ui font-semibold flex-1 truncate" title={agentName()}>
          {agentName()}
        </span>
        <button
          onClick={() => clearAgentThread(props.wtId, props.tabId)}
          title="Clear conversation"
          aria-label="Clear conversation"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring outline-none transition-colors"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
        {props.headerActions}
      </div>

      <div
        ref={scroller}
        class="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 py-3 space-y-3"
      >
        <Show when={repoPath()} fallback={<Notice>Open a folder to ask about it.</Notice>}>
          <Show
            when={command()}
            fallback={
              <Notice>
                No AI command configured for {agentName()}. The agent pipes a grounded
                prompt to your own CLI (e.g. <code class="font-mono">claude -p</code>).
                <button
                  onClick={props.onOpenSettings}
                  class="mt-2 inline-flex items-center gap-1 text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring outline-none rounded"
                >
                  <Settings2 class="w-3 h-3" /> Open Settings → AI
                </button>
              </Notice>
            }
          >
            <Show
              when={messages().length > 0}
              fallback={
                <Notice>
                  Ask about this repo — “what changed on this branch?”, “summarize the
                  staged diff”, “which commit introduced X?”. Each answer shows the
                  workspace context it used.
                </Notice>
              }
            >
              <For each={messages()}>{(m) => <MessageBubble msg={m} />}</For>
            </Show>
            <Show when={retryable()}>
              <div class="flex">
                <button
                  onClick={() => {
                    const repo = repoPath();
                    if (repo) void retryAgentTurn({ ...grounding(), repoPath: repo });
                  }}
                  class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border/60 bg-muted/40 text-body text-foreground hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring outline-none transition-colors"
                >
                  <RotateCcw class="w-3 h-3" /> Retry
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      <div class="shrink-0 border-t border-border/60 p-2">
        <div class="flex items-end gap-2">
          <textarea
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask about this repo…   (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={!repoPath() || !command()}
            title={
              !repoPath()
                ? "No folder is open"
                : !command()
                  ? `${agentName()} has no CLI command configured`
                  : undefined
            }
            aria-disabled={!repoPath() || !command() ? "true" : undefined}
            class="flex-1 resize-none px-2 py-1.5 text-ui bg-muted/50 border border-border/60 rounded-md outline-2 outline-transparent focus-visible:ring-2 focus-visible:ring-ring placeholder:text-muted-foreground/60 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Agent question"
          />
          {/* Stop replaces Send while a turn runs, rather than Send going
              disabled with a spinner beside it. §7.6: never disable a control as
              the only way of saying "busy" — and the thing a user wants during a
              forty-second answer is a way out of it, not a greyed button. */}
          <Show
            when={busy()}
            fallback={
              <button
                onClick={() => void send()}
                disabled={!repoPath() || !command() || !input().trim()}
                title={sendTitle(!!repoPath(), !!command(), !!input().trim())}
                aria-disabled={
                  !repoPath() || !command() || !input().trim() ? "true" : undefined
                }
                aria-label="Send"
                class="p-2 rounded-md bg-primary/15 text-primary hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring outline-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <CornerDownLeft class="w-4 h-4" />
              </button>
            }
          >
            <button
              onClick={() => void cancelAgentTurn(props.wtId, props.tabId)}
              title="Stop this turn"
              aria-label="Stop this turn"
              class="p-2 rounded-md bg-destructive/15 text-destructive hover:bg-destructive/25 focus-visible:ring-2 focus-visible:ring-ring outline-none transition-colors"
            >
              <Square class="w-4 h-4" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/// §7.6 forbids a disabled control with no stated reason, so every way of
/// getting there names itself.
function sendTitle(hasRepo: boolean, hasCommand: boolean, hasText: boolean): string {
  if (!hasRepo) return "No folder is open";
  if (!hasCommand) return "This agent has no CLI command configured";
  if (!hasText) return "Type a question first";
  return "Send";
}

function Notice(props: { children: JSX.Element }) {
  return (
    <div class="text-body text-muted-foreground leading-relaxed px-1 py-2">
      {props.children}
    </div>
  );
}

function MessageBubble(props: { msg: AgentMessage }) {
  const isUser = () => props.msg.role === "user";
  const isError = () => props.msg.role === "error";
  const streaming = () => props.msg.status === "streaming";
  const html = createMemo(() => {
    if (isUser()) return "";
    const raw = marked.parse(props.msg.content, {
      async: false,
      breaks: true,
      gfm: true,
    }) as string;
    return DOMPurify.sanitize(raw);
  });

  return (
    <div class={`flex flex-col gap-1 ${isUser() ? "items-end" : "items-start"}`}>
      <div
        class={`max-w-full rounded-lg px-3 py-2 text-ui ${
          isUser()
            ? "bg-primary/15 text-foreground"
            : isError()
              ? "bg-destructive/10 text-destructive"
              : "bg-muted/50 text-foreground"
        }`}
      >
        <Show
          when={!isUser()}
          fallback={<span class="whitespace-pre-wrap">{props.msg.content}</span>}
        >
          <Show
            when={!isError()}
            fallback={
              <span class="whitespace-pre-wrap font-mono text-body">
                {props.msg.content}
              </span>
            }
          >
            {/* Append-in-place: the answer grows as chunks land and the region is
                never blanked to show that it is updating (§7.5.2/§7.5.4). An
                empty streaming bubble carries the pending mark instead of a
                skeleton, so nothing that was readable stops being readable. */}
            <Show
              when={props.msg.content.length > 0}
              fallback={
                <span class="inline-flex items-center gap-2 text-muted-foreground">
                  <StatusLed signal="running" pending class="motion-loop" silent />
                  Thinking…
                </span>
              }
            >
              <div class="markdown-body agent-md leading-[1.55]" innerHTML={html()} />
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={props.msg.status === "cancelled"}>
        <span class="text-label text-muted-foreground">Stopped — partial answer</span>
      </Show>
      {/* Audit attaches on completion, which is why a streaming turn shows no
          disclosure: its arrival is itself the signal that the turn landed. */}
      <Show when={!streaming() && props.msg.audit && props.msg.audit.length > 0}>
        <AuditDisclosure msg={props.msg} />
      </Show>
    </div>
  );
}

function AuditDisclosure(props: { msg: AgentMessage }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="text-label text-muted-foreground">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
        class="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none transition-colors"
      >
        <Show when={open()} fallback={<ChevronRight class="w-3 h-3" />}>
          <ChevronDown class="w-3 h-3" />
        </Show>
        Context used ({props.msg.audit!.length})
        <Show when={props.msg.ms !== undefined}>
          <span class="opacity-60">· {formatMs(props.msg.ms!)}</span>
        </Show>
      </button>
      <Show when={open()}>
        <ul class="mt-1 ml-4 space-y-0.5">
          <For each={props.msg.audit}>
            {(a) => (
              <li class="flex gap-2">
                <span class="text-foreground/80">{a.label}</span>
                <span class="opacity-60">{a.detail}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
