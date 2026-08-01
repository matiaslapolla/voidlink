/// One PTY poll per shell, plus the output-rate window, shared by everything
/// that needs to know what a terminal is doing.
///
/// `TabStrip` used to own the poll: each terminal tab ran its own 1.5s
/// `processInfo` poll so it could wear the name of the command running in it.
/// That was fine while the strip was the only consumer and always mounted — and
/// stopped being fine the moment activity had to escalate. Under zen there is no
/// strip at all, so nothing polled, so a command that failed in a background
/// shell reported itself nowhere. A signal that only exists while someone is
/// looking at the surface it would appear on is not a signal.
///
/// So the poll lives here, keyed by `ptyId` and refcounted: the strip and the
/// pane layer both subscribe, and there is still exactly one `invoke` per shell
/// per interval. The strip keeps reading `busy`/`processName` for its label; the
/// transitions are reported to `store/activity.ts` as they happen, whether or
/// not anything is rendering them.
///
/// ## Why `busy` is not "working"
///
/// `busy` is `tcgetpgrp(master_fd) != shell_pid` — is *anything* in the
/// foreground other than the shell. For `claude`, `vim`, `lazygit` or any other
/// TUI that is true for the entire session, from launch to quit. So a tab with a
/// TUI merely *open* used to sit permanently on the orange pulsing "running"
/// mark, and there was no way to tell it from a build that was genuinely
/// churning.
///
/// The observable that does distinguish them is **output rate**. A program doing
/// work writes to its PTY; a program waiting at a prompt does not. So
/// `TerminalPane` reports the bytes it receives, this module windows them, and
/// `working = busy && outputActive`.
///
/// The tradeoff, stated rather than hidden: a genuinely silent long-running
/// command (`sleep 60`, a `curl` with no progress meter) reads as idle. Output is
/// a proxy, and this is the case it gets wrong. It was chosen over sampling the
/// foreground pid's CPU state because it needs no new IPC and no per-platform
/// `/proc` reading, and because the failure mode is "quiet dot" rather than
/// "permanently wrong dot".
///
/// ## Why the poll is not the only source any more
///
/// The poll can see *that* a foreground process went away and never *how* it
/// went. That is the whole reason `failed` — the top of §7.5.3's precedence
/// chain — used to be unreachable from a terminal: `noteFinished(tabId, true)`
/// was hardcoded below, because `true` was the only claim the observable
/// supported. Only the shell knows `$?`.
///
/// So a second source now feeds the same rules: OSC 133 semantic prompts,
/// parsed in `store/semanticPrompt.ts` and delivered here by
/// `noteSemanticPrompt`. When a shell emits them, its `D` mark is authoritative
/// and the poll's falling-edge completion is **suppressed for that shell** —
/// see `poll`. When it does not, nothing changes: the poll path below is
/// exactly what it was, which is the point. Shell integration is opt-in and a
/// shell without it must behave no worse than it did yesterday, never claiming
/// a status nobody told it.
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { terminalApi } from "@/api/terminal";
import { noteFinished, noteWorking } from "@/store/activity";
import { record } from "@/store/journal";
import {
  commandFailed,
  commandIsNews,
  type SemanticPromptMark,
} from "@/store/semanticPrompt";

const POLL_MS = 1500;

/// The output-rate window. Tuned by hand against three cases: `yes | head -c 1M`
/// (thousands of bytes per frame — must read as working), `claude` sitting at its
/// prompt (a keystroke echo every few seconds at most — must read as idle), and
/// `npm install`'s spinner (a few dozen bytes every ~80ms — must read as
/// working).
///
/// 256 bytes / 500ms is above a cursor blink and a keystroke echo and well below
/// any real progress output. `OUTPUT_IDLE_MS` is what turns working back off; it
/// matches `POLL_MS` so the two clocks cannot disagree for longer than one tick.
const OUTPUT_WINDOW_MS = 500;
const OUTPUT_BYTES_THRESHOLD = 256;
const OUTPUT_IDLE_MS = 1500;

/// Busy-edge hysteresis: how many consecutive polls must see the same foreground
/// process before its exit counts as a completion worth reporting.
///
/// Two, because one is indistinguishable from noise. The poll samples every
/// 1500ms, so a 20ms command that happens to straddle a tick is seen busy
/// exactly once — and used to be badged "finished" for a full interval, for
/// something the user did not wait for and would not call an event. Requiring
/// two samples (with the same pid, so two consecutive short commands do not add
/// up) means a reported completion is one that genuinely took a second or more.
///
/// The other half of the poll's resolution limit is unfixed and unfixable from
/// here: a command that starts and ends between two ticks is invisible. That is
/// the right answer anyway — nobody wants a badge for `ls`.
const MIN_BUSY_SAMPLES = 2;

interface PtyState {
  // ── Process poll
  busy: Accessor<boolean>;
  setBusy: (v: boolean) => void;
  name: Accessor<string | null>;
  setName: (v: string | null) => void;

  // ── Output rate
  outputActive: Accessor<boolean>;
  setOutputActive: (v: boolean) => void;
  windowStart: number;
  windowBytes: number;
  idleTimer: ReturnType<typeof setTimeout> | null;

  // ── Alternate screen (S10)
  /// The emulator is currently in the alternate buffer — a full-screen app.
  altScreen: boolean;

  // ── Busy-span bookkeeping, for the hysteresis above
  busySamples: number;
  busyPid: number | null;
  /// Did the shell enter the alternate screen at any point during this busy
  /// span? Quitting `vim` while unfocused used to raise a green "finished" mark,
  /// which is nonsense — you closed an editor, nothing completed. Remembered for
  /// the whole span because by the falling edge the app has already restored the
  /// normal buffer.
  busySpanAlt: boolean;
  /// The foreground process's name, captured *during* the span. By the falling
  /// edge the shell is idle again and `info.name` is null, so the one piece of
  /// information that makes a completion worth recording has to be kept as it
  /// goes past.
  busyName: string | null;

  // ── Shell integration (OSC 133)
  /// This shell has emitted at least one semantic prompt mark, so it is wired
  /// up and its `D` marks are the authority on completion. Latched rather than
  /// re-derived per command: integration is a property of the shell's startup
  /// files, and a shell that has proved it once does not stop having it —
  /// whereas a *single* command that produces no marks (a `read` at a prompt, a
  /// TUI that swallows the hooks) would un-latch a per-command flag and hand
  /// the poll back a shell it would then report without a status.
  integrated: boolean;
  /// When the current command started (`C`), or `null` between commands. Also
  /// `null` when we attached mid-command, which is what makes "we saw the end
  /// but not the beginning" distinguishable from "it took no time at all".
  commandStartedAt: number | null;
  /// The alternate-screen equivalent of `busySpanAlt`, for the C→D span. Kept
  /// separately because the two spans do not coincide: the poll's span starts
  /// up to 1500ms late and ends up to 1500ms after the command really did.
  commandSpanAlt: boolean;

  // ── Poll lifetime
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  /// Tab this PTY reports activity against. One shell is shown by one tab.
  tabId: string | null;
}

const states = new Map<string, PtyState>();

function stateFor(ptyId: string): PtyState {
  let state = states.get(ptyId);
  if (state) return state;
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal<string | null>(null);
  const [outputActive, setOutputActive] = createSignal(false);
  state = {
    busy,
    setBusy,
    name,
    setName,
    outputActive,
    setOutputActive,
    windowStart: 0,
    windowBytes: 0,
    idleTimer: null,
    altScreen: false,
    busySamples: 0,
    busyPid: null,
    busySpanAlt: false,
    busyName: null,
    integrated: false,
    commandStartedAt: null,
    commandSpanAlt: false,
    refs: 0,
    timer: null,
    tabId: null,
  };
  states.set(ptyId, state);
  return state;
}

/// `working` for one shell: busy **and** producing output. The single definition;
/// nothing else should be combining these two bits.
function isWorking(state: PtyState): boolean {
  return state.busy() && state.outputActive();
}

function pushWorking(state: PtyState) {
  if (state.tabId) noteWorking(state.tabId, isWorking(state));
}

// ── Output rate ─────────────────────────────────────────────────────────────

/// Report bytes received from a PTY. Called from `TerminalPane`'s existing
/// `onData` handler — the component counts nothing and decides nothing, it just
/// forwards the length.
export function noteTerminalOutput(ptyId: string, byteLength: number): void {
  const state = stateFor(ptyId);
  const now = Date.now();
  if (now - state.windowStart > OUTPUT_WINDOW_MS) {
    state.windowStart = now;
    state.windowBytes = 0;
  }
  state.windowBytes += byteLength;

  if (state.windowBytes >= OUTPUT_BYTES_THRESHOLD && !state.outputActive()) {
    state.setOutputActive(true);
    pushWorking(state);
  }

  // Any output at all postpones the silence deadline. Bytes below the rate
  // threshold cannot *start* working, but they are not silence either.
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    state.windowBytes = 0;
    if (!state.outputActive()) return;
    state.setOutputActive(false);
    pushWorking(state);
  }, OUTPUT_IDLE_MS);
}

/// Report whether the emulator is in the alternate screen buffer — i.e. whether a
/// full-screen app is on screen. Used only to suppress a nonsense completion mark
/// when that app exits.
export function noteTerminalAltScreen(ptyId: string, active: boolean): void {
  const state = stateFor(ptyId);
  state.altScreen = active;
  if (active) {
    state.busySpanAlt = true;
    state.commandSpanAlt = true;
  }
}

/// Is this shell producing output right now? Exposed for tests and for the
/// sidebar, which needs the same `working` derivation the tab strip uses.
export function terminalOutputActive(ptyId: string): boolean {
  return states.get(ptyId)?.outputActive() ?? false;
}

// ── Shell integration ───────────────────────────────────────────────────────

/// How many live shells have proved they emit OSC 133.
///
/// Reactive, and it exists for exactly one surface: the settings screen's
/// "shell integration" row, which has to answer *did my rc change work?*. A
/// count of shells that have actually emitted a mark is the only honest answer
/// available — there is no way to ask a shell what it sourced — so the row says
/// what was observed and nothing more.
const [integratedCount, setIntegratedCount] = createSignal(0);

/// The number of open shells emitting semantic prompts. Reactive.
export const shellsWithIntegration = integratedCount;

/// Does this specific shell have integration? Used by the poll to decide who
/// owns the completion event.
export function terminalIsIntegrated(ptyId: string): boolean {
  return states.get(ptyId)?.integrated ?? false;
}

/// A semantic prompt mark arrived from a shell. `TerminalPane` parses it out of
/// the OSC 133 handler and forwards it; the component decides nothing.
///
/// **Must not be called during scrollback replay.** Re-attaching a pane re-feeds
/// every byte the session ever produced through the parser, so every `D` the
/// shell has *ever* written would arrive again — a worktree switch would repaint
/// the whole morning's failures as fresh red marks. The caller gates on the same
/// `replaying` flag that already suppresses the emulator's query answers, for
/// the same reason: a replay is us repainting the past, not the past happening.
export function noteSemanticPrompt(ptyId: string, mark: SemanticPromptMark): void {
  const state = stateFor(ptyId);
  if (!state.integrated) {
    state.integrated = true;
    setIntegratedCount((n) => n + 1);
  }

  switch (mark.kind) {
    case "command-start":
      state.commandStartedAt = Date.now();
      state.commandSpanAlt = state.altScreen;
      return;
    case "command-end":
      endCommand(state, mark.exitCode);
      return;
    // `A` and `B` bracket the prompt itself. Nothing between them is a command,
    // so there is no state to keep — they are here only as the evidence above
    // that this shell is wired up at all.
    case "prompt-start":
    case "prompt-end":
      return;
  }
}

/// A command ended, with a status the shell actually reported.
function endCommand(state: PtyState, exitCode: number | null): void {
  const startedAt = state.commandStartedAt;
  const wasFullScreen = state.commandSpanAlt;
  state.commandStartedAt = null;
  state.commandSpanAlt = false;

  const durationMs = startedAt === null ? null : Date.now() - startedAt;
  const failed = commandFailed(exitCode);
  const news = commandIsNews({ durationMs, exitCode, wasFullScreen });

  if (news) {
    // The command's own name is the poll's to know — `D` carries a status and
    // nothing else, and inventing a proprietary extension to carry the command
    // line (VS Code's OSC 633) would mean shipping a sequence only our own
    // snippet emits. The poll has been sampling the foreground process for the
    // life of the span and has not yet seen the falling edge, so `busyName` is
    // still the right answer; it is only null for commands too short for the
    // poll to have caught, and those are below the news threshold anyway.
    const name = state.busyName ?? state.name();
    record({
      kind: failed ? "terminal.command.failed" : "terminal.command.finished",
      subject: name ?? undefined,
      // Says "finished" and not "succeeded" when the status is unknown, on the
      // same principle the poll's summary already followed: never claim a
      // result nobody reported.
      summary: failed
        ? `${name ?? "a command"} failed (exit ${exitCode})`
        : `${name ?? "a command"} finished`,
      data: {
        process: name,
        tabId: state.tabId,
        exitCode,
        // Real, not a lower bound: this is C's timestamp to D's, which is the
        // shell telling us rather than us sampling.
        durationMs,
        source: "osc133",
      },
    });
  }

  if (!state.tabId) return;
  if (news) {
    // The one line this whole feature exists for. `ok === false` is the only
    // path to `failed` from a terminal, and `noteFinished` — not this module —
    // owns what that means for the badge.
    noteFinished(state.tabId, !failed);
  } else {
    noteWorking(state.tabId, false);
  }
}

// ── The poll ────────────────────────────────────────────────────────────────

/// Was a busy span that just ended a *completion* the user should be told about?
///
/// Pure, so both rules are testable without a PTY. `samples` is how many
/// consecutive polls saw the *same* foreground process (the poll restarts the
/// count when the pid changes, so two short commands never add up), and
/// `wasFullScreen` is whether it ever painted the alternate screen.
export function completionIsNews(span: {
  samples: number;
  wasFullScreen: boolean;
}): boolean {
  // Quitting an editor is not a build finishing.
  if (span.wasFullScreen) return false;
  return span.samples >= MIN_BUSY_SAMPLES;
}

async function poll(ptyId: string, state: PtyState) {
  let info;
  try {
    info = await terminalApi.processInfo(ptyId);
  } catch {
    // The PTY went away; the tab is about to be removed anyway.
    return;
  }
  const wasBusy = state.busy();
  state.setBusy(info.busy);
  state.setName(info.name);

  if (info.busy) {
    if (!wasBusy) {
      // Rising edge: start a new span.
      state.busySamples = 1;
      state.busyPid = info.pid ?? null;
      state.busySpanAlt = state.altScreen;
      state.busyName = info.name;
    } else {
      state.busySamples += 1;
      if ((info.pid ?? null) !== state.busyPid) {
        // A different foreground process: this is a new span, not a longer one.
        state.busySamples = 1;
        state.busyPid = info.pid ?? null;
        state.busySpanAlt = state.altScreen;
        state.busyName = info.name;
      } else if (info.name) {
        state.busyName = info.name;
      }
    }
    if (state.altScreen) state.busySpanAlt = true;
    pushWorking(state);
    return;
  }

  if (!wasBusy) return;

  // Falling edge. `working` goes off either way; whether it counts as news is
  // the hysteresis question.
  //
  // Except in a shell that emits OSC 133, where it is not this module's
  // question at all. Two sources reporting the same command would put a
  // `terminal.command.failed` and a `terminal.command.finished` in the log for
  // one `cargo build`, and fire two OS notifications saying opposite things —
  // the badge would survive it (`failed` outranks `notify`) but the log and the
  // banners would not. The shell's own status is strictly better information
  // than a poll's silence, so the poll stands down entirely and keeps only the
  // job the marks cannot do: turning `working` back off.
  //
  // `busyName` is deliberately *not* cleared here, unlike below. The two clocks
  // are independent: the poll can sample idle in the gap between the command
  // exiting and the shell writing its `D`, and clearing the name in that window
  // would leave the record saying "a command failed" for something we knew the
  // name of a moment earlier. It is overwritten on the next rising edge, so it
  // cannot leak into a later command.
  if (state.integrated) {
    state.busySamples = 0;
    state.busyPid = null;
    state.busySpanAlt = false;
    if (state.tabId) noteWorking(state.tabId, false);
    return;
  }

  const news = completionIsNews({
    samples: state.busySamples,
    wasFullScreen: state.busySpanAlt,
  });
  // Recorded before the badge decision, and on the *same* rule.
  //
  // `completionIsNews` is the right gate for the log too, for a reason worth
  // stating: it is what separates "a command ran" from "the shell was busy for
  // a moment". Everything it rejects is a sub-second command or somebody
  // quitting an editor, and a log full of those is a log nobody reads. The
  // badge and the record are the same event seen at two zoom levels, so they
  // must not be able to disagree about whether it happened.
  if (news && state.busyName) {
    record({
      kind: "terminal.command.finished",
      subject: state.busyName,
      // The poll cannot see the exit status — only that the foreground process
      // went away — so the summary claims completion and not success.
      summary: `${state.busyName} finished`,
      data: {
        process: state.busyName,
        tabId: state.tabId,
        // Lower bound: the span was observed for this long. The command started
        // at some point in the poll interval before the first busy sample.
        approxMs: state.busySamples * POLL_MS,
      },
    });
  }
  state.busySamples = 0;
  state.busyPid = null;
  state.busySpanAlt = false;
  state.busyName = null;
  if (!state.tabId) return;
  if (news) {
    // `noteFinished` decides whether that is a badge (the user was elsewhere) or
    // nothing at all (they watched it happen).
    noteFinished(state.tabId, true);
  } else {
    noteWorking(state.tabId, false);
  }
}

export interface TerminalWatch {
  /// A foreground command is running in this shell. `true` for the whole life of
  /// a TUI — read `working` for "is it doing something".
  busy: Accessor<boolean>;
  /// Busy **and** producing output. What the LED's `working` state reads.
  working: Accessor<boolean>;
  /// The foreground process name, so the tab can wear it. `null` at an idle
  /// prompt.
  processName: Accessor<string | null>;
}

/// Subscribe to `ptyId`'s process state, reporting activity against `tabId`.
/// Must be called inside a reactive owner — the subscription is released on
/// cleanup, and the poll stops when the last subscriber goes.
export function watchTerminal(tabId: string, ptyId: string): TerminalWatch {
  const state = stateFor(ptyId);
  state.tabId = tabId;
  if (!state.timer) {
    void poll(ptyId, state);
    state.timer = setInterval(() => void poll(ptyId, state), POLL_MS);
  }

  state.refs += 1;
  onCleanup(() => {
    state.refs -= 1;
    if (state.refs > 0) return;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    if (state.integrated) setIntegratedCount((n) => Math.max(0, n - 1));
    states.delete(ptyId);
  });

  return {
    busy: state.busy,
    working: () => isWorking(state),
    processName: state.name,
  };
}

/// Test seam: drop every poll and every window. Nothing in the app calls it.
export function resetTerminalWatchers(): void {
  for (const state of states.values()) {
    if (state.timer) clearInterval(state.timer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
  }
  states.clear();
  setIntegratedCount(0);
}
