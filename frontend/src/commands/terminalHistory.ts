import { invoke } from "@tauri-apps/api/core";

/// Records the last command line typed into each PTY and the id of the most
/// recently focused terminal. `TerminalPane` calls `recordKeystroke` on every
/// user keystroke; pressing Enter snapshots the buffer as "last command" and
/// resets. Backspace (DEL 0x7f / 0x08) edits the buffer. Anything more exotic
/// (history-recall arrows, line clears) we deliberately don't track — the
/// recorded value is only ever used to *replay* what the user just typed, not
/// to reconstruct shell history.
///
/// State lives at module scope so a global keybinding can fire repeatLast
/// without having to thread the active workspace through.

interface PtyHistory {
  buffer: string;
  lastCommand: string | null;
}

const histories = new Map<string, PtyHistory>();
let mostRecentPty: string | null = null;

function get(ptyId: string): PtyHistory {
  let h = histories.get(ptyId);
  if (!h) {
    h = { buffer: "", lastCommand: null };
    histories.set(ptyId, h);
  }
  return h;
}

/// A command line long enough that nothing beyond it is a command line any more.
/// Only reachable when something we failed to classify is being appended
/// forever; a real typed command is orders of magnitude shorter.
const MAX_BUFFER_CHARS = 4096;

export function recordKeystroke(ptyId: string, data: string) {
  mostRecentPty = ptyId;
  // `term.onData` carries everything the emulator sends up the input path, and
  // that is not only typing: with mouse reporting on — lazygit, vim with
  // `set mouse=a`, any Ink app that tracks the pointer — every pointer move
  // emits an SGR report like `\x1b[<35;40;12M`. The escape itself is skipped by
  // the loop below, but `[<35;40;12M` is all printable, so it was appended; and
  // since a full-screen app never sends a bare CR through this path, nothing
  // ever reset the buffer. It grew for the life of the pane, and
  // `repeatLastCommand` would eventually replay mouse noise as a command.
  //
  // Anything beginning with ESC is the emulator talking, not the user.
  if (data.charCodeAt(0) === 0x1b) return;
  const h = get(ptyId);
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) {
      // Enter: snapshot. Only keep if non-trivial.
      const trimmed = h.buffer.trim();
      if (trimmed) h.lastCommand = trimmed;
      h.buffer = "";
    } else if (code === 0x7f || code === 0x08) {
      // Backspace.
      h.buffer = h.buffer.slice(0, -1);
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C or Ctrl-U — abandon the line.
      h.buffer = "";
    } else if (code >= 0x20) {
      // Backstop for any other sequence that reaches here without a leading
      // ESC. Dropping the oldest chars keeps whatever the user most recently
      // typed, which is the half `repeatLastCommand` would want.
      if (h.buffer.length >= MAX_BUFFER_CHARS) h.buffer = h.buffer.slice(-MAX_BUFFER_CHARS / 2);
      h.buffer += ch;
    }
  }
}

export function markActive(ptyId: string) {
  mostRecentPty = ptyId;
}

export function forget(ptyId: string) {
  histories.delete(ptyId);
  if (mostRecentPty === ptyId) mostRecentPty = null;
}

export function getMostRecentPtyId(): string | null {
  return mostRecentPty;
}

export async function repeatLastCommand(): Promise<{ ok: boolean; reason?: string }> {
  const pty = mostRecentPty;
  if (!pty) return { ok: false, reason: "No terminal has been used yet" };
  const h = histories.get(pty);
  const cmd = h?.lastCommand;
  if (!cmd) return { ok: false, reason: "No previous command recorded for this terminal" };
  await invoke("write_pty", { sessionId: pty, data: cmd + "\r" });
  return { ok: true };
}
