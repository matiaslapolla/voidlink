/// One PTY poll per shell, shared by everything that needs to know what a
/// terminal is doing.
///
/// `TabStrip` used to own this: each terminal tab ran its own 1.5s
/// `processInfo` poll so it could wear the name of the command running in it.
/// That was fine while the strip was the only consumer and always mounted —
/// and stopped being fine the moment activity had to escalate. Under zen there
/// is no strip at all, so nothing polled, so a command that failed in a
/// background shell reported itself nowhere. A signal that only exists while
/// someone is looking at the surface it would appear on is not a signal.
///
/// So the poll moved here, keyed by `ptyId` and refcounted: the strip and the
/// pane layer both subscribe, and there is still exactly one `invoke` per shell
/// per interval. The strip keeps reading `busy`/`processName` for its label;
/// the transitions are reported to `store/activity.ts` as they happen,
/// whether or not anything is rendering them.
///
/// **Known gap, and it needs a Rust change to close.** `pty-exit` is emitted
/// with a unit payload (`src-tauri/src/lib.rs`), so the frontend cannot see a
/// shell's exit code, and the workbench closes a terminal tab when its shell
/// exits anyway. What is observable from here is the *foreground command*
/// cycle — busy → idle — which is the signal a user actually watches for
/// ("is my build done?"). It maps to `finished`. `failed` is reachable only
/// through `noteFinished(id, false)`, which nothing calls yet; wiring it up
/// means teaching the Rust side to report the exit status, which is out of
/// scope for a frontend-only wave.
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { terminalApi } from "@/api/terminal";
import { noteFinished, noteRunning } from "@/store/activity";

const POLL_MS = 1500;

interface Watcher {
  refs: number;
  timer: ReturnType<typeof setInterval>;
  busy: Accessor<boolean>;
  setBusy: (v: boolean) => void;
  name: Accessor<string | null>;
  setName: (v: string | null) => void;
}

const watchers = new Map<string, Watcher>();

export interface TerminalWatch {
  /// A foreground command is running in this shell.
  busy: Accessor<boolean>;
  /// Its process name, so the tab can wear it. `null` at an idle prompt.
  processName: Accessor<string | null>;
}

/// Subscribe to `ptyId`'s process state, reporting activity against `tabId`.
/// Must be called inside a reactive owner — the subscription is released on
/// cleanup, and the poll stops when the last subscriber goes.
export function watchTerminal(tabId: string, ptyId: string): TerminalWatch {
  let watcher = watchers.get(ptyId);
  if (!watcher) {
    const [busy, setBusy] = createSignal(false);
    const [name, setName] = createSignal<string | null>(null);
    let wasBusy = false;
    const poll = async () => {
      try {
        const info = await terminalApi.processInfo(ptyId);
        setBusy(info.busy);
        setName(info.name);
        if (info.busy !== wasBusy) {
          // Rising edge: a command started. Falling edge: it ended, and
          // `noteFinished` decides whether that is news (the user was
          // elsewhere) or nothing at all (they watched it happen).
          if (info.busy) noteRunning(tabId, true);
          else noteFinished(tabId, true);
          wasBusy = info.busy;
        }
      } catch {
        /* the PTY went away; the tab is about to be removed anyway */
      }
    };
    void poll();
    watcher = {
      refs: 0,
      timer: setInterval(() => void poll(), POLL_MS),
      busy,
      setBusy,
      name,
      setName,
    };
    watchers.set(ptyId, watcher);
  }

  const entry = watcher;
  entry.refs += 1;
  onCleanup(() => {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    clearInterval(entry.timer);
    watchers.delete(ptyId);
  });

  return { busy: entry.busy, processName: entry.name };
}

/// Test seam: drop every poll. Nothing in the app calls it.
export function resetTerminalWatchers(): void {
  for (const w of watchers.values()) clearInterval(w.timer);
  watchers.clear();
}
