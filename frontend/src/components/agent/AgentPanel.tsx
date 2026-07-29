import { For, Show, createMemo, createSignal, createEffect, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Bot, X, Trash2, CornerDownLeft, Loader2, ChevronDown, ChevronRight, Settings2 } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import {
  agentBusy,
  agentPanelOpen,
  agentThread,
  askAgent,
  clearAgentThread,
  toggleAgentPanel,
  type AgentMessage,
} from "@/commands/agent";

/// Right-edge slide-over for the workspace-grounded repo agent. The agent
/// rides on the same BYO-CLI adapter as commit drafting; what makes it the
/// agent (vs. a generic chat box) is that every turn is grounded in live
/// workspace state — branch, status, log, staged diff, open files — gathered
/// through the same commands the UI renders from, with an auditable trail of
/// which sources fed each answer.
export function AgentPanel(props: { onOpenSettings: () => void }) {
  const { state, activeRepoPath, activeOpenFiles, editorActiveItem } = useAppStore();
  const { settings } = useSettings();
  const [input, setInput] = createSignal("");
  let scroller: HTMLDivElement | undefined;

  const repoPath = () => activeRepoPath() ?? null;
  const wtId = () => state.activeWorktreeId;
  const command = () =>
    (settings.ai.agentCommand?.trim() || settings.ai.commitCommand?.trim()) ?? "";
  const messages = createMemo(() => agentThread(wtId()));
  /// The file the user is looking at, for grounding. Read from the *editor*
  /// window's pointer: files moved to that window, so the workbench's own
  /// pointer never names one and this would otherwise always be null.
  const activePath = () => {
    const a = editorActiveItem();
    return a && (a.type === "file" || a.type === "preview") ? a.path : null;
  };

  // Auto-scroll to the newest message / streaming state.
  createEffect(() => {
    messages();
    agentBusy();
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  async function send() {
    const repo = repoPath();
    const q = input().trim();
    if (!repo || !q || agentBusy()) return;
    if (!command()) return;
    setInput("");
    await askAgent({
      wtId: wtId(),
      repoPath: repo,
      commandTemplate: command(),
      question: q,
      openFiles: activeOpenFiles().map((f) => f.path),
      activePath: activePath(),
    });
  }

  return (
    <Show when={agentPanelOpen()}>
      <Portal>
        <div class="fixed inset-y-0 right-0 z-40 w-[440px] max-w-[92vw] flex flex-col bg-background border-l border-border shadow-xl">
          {/* Header */}
          <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
            <Bot class="w-4 h-4 text-primary" />
            <span class="text-[13px] font-semibold flex-1">Repo agent</span>
            <button
              onClick={() => clearAgentThread(wtId())}
              title="Clear conversation"
              aria-label="Clear conversation"
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => toggleAgentPanel(false)}
              title="Close"
              aria-label="Close agent panel"
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Body */}
          <div ref={scroller} class="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-3">
            <Show
              when={repoPath()}
              fallback={<Notice>Select a repository to ask about it.</Notice>}
            >
              <Show
                when={command()}
                fallback={
                  <Notice>
                    No AI command configured. The agent pipes a grounded prompt to your
                    own CLI (e.g. <code class="font-mono">claude -p</code>).
                    <button
                      onClick={props.onOpenSettings}
                      class="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
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
                <Show when={agentBusy()}>
                  <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    Thinking…
                  </div>
                </Show>
              </Show>
            </Show>
          </div>

          {/* Composer */}
          <div class="shrink-0 border-t border-border p-2">
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
                class="flex-1 resize-none px-2 py-1.5 text-[13px] bg-muted/50 border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60 disabled:opacity-50"
                aria-label="Agent question"
              />
              <button
                onClick={() => void send()}
                disabled={!repoPath() || !command() || agentBusy() || !input().trim()}
                title="Send"
                aria-label="Send"
                class="p-2 rounded-md bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <CornerDownLeft class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function Notice(props: { children: JSX.Element }) {
  return (
    <div class="text-[12px] text-muted-foreground leading-relaxed px-1 py-2">
      {props.children}
    </div>
  );
}

function MessageBubble(props: { msg: AgentMessage }) {
  const isUser = () => props.msg.role === "user";
  const isError = () => props.msg.role === "error";
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
        class={`max-w-full rounded-lg px-3 py-2 text-[13px] ${
          isUser()
            ? "bg-primary/15 text-foreground"
            : isError()
              ? "bg-destructive/10 text-destructive"
              : "bg-muted/50 text-foreground"
        }`}
      >
        <Show when={!isUser()} fallback={<span class="whitespace-pre-wrap">{props.msg.content}</span>}>
          <Show
            when={!isError()}
            fallback={<span class="whitespace-pre-wrap font-mono text-[12px]">{props.msg.content}</span>}
          >
            <div class="markdown-body agent-md leading-[1.55]" innerHTML={html()} />
          </Show>
        </Show>
      </div>
      <Show when={props.msg.audit && props.msg.audit.length > 0}>
        <AuditDisclosure msg={props.msg} />
      </Show>
    </div>
  );
}

function AuditDisclosure(props: { msg: AgentMessage }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="text-[11px] text-muted-foreground">
      <button
        onClick={() => setOpen((v) => !v)}
        class="inline-flex items-center gap-1 hover:text-foreground transition-colors"
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
