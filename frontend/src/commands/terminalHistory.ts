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

export function recordKeystroke(ptyId: string, data: string) {
  mostRecentPty = ptyId;
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
