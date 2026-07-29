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
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { terminalApi } from "@/api/terminal";
import { noteFinished, noteWorking } from "@/store/activity";

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
  if (active) state.busySpanAlt = true;
}

/// Is this shell producing output right now? Exposed for tests and for the
/// sidebar, which needs the same `working` derivation the tab strip uses.
export function terminalOutputActive(ptyId: string): boolean {
  return states.get(ptyId)?.outputActive() ?? false;
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
    } else {
      state.busySamples += 1;
      if ((info.pid ?? null) !== state.busyPid) {
        // A different foreground process: this is a new span, not a longer one.
        state.busySamples = 1;
        state.busyPid = info.pid ?? null;
        state.busySpanAlt = state.altScreen;
      }
    }
    if (state.altScreen) state.busySpanAlt = true;
    pushWorking(state);
    return;
  }

  if (!wasBusy) return;

  // Falling edge. `working` goes off either way; whether it counts as news is
  // the hysteresis question.
  const news = completionIsNews({
    samples: state.busySamples,
    wasFullScreen: state.busySpanAlt,
  });
  state.busySamples = 0;
  state.busyPid = null;
  state.busySpanAlt = false;
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
}
