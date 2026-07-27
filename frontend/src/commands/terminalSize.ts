/// Terminal grid sizes, remembered across pane mounts.
///
/// Two questions, deliberately kept apart:
///
///   • `sizeForPty` — "what winsize does *this* PTY currently have?" A pane
///     that unmounts (switching worktrees) leaves its shell running, and the
///     xterm rebuilt on remount starts at 80×24. Without the real figure the
///     replayed scrollback renders at a width the shell never wrapped for.
///
///   • `lastGridSize` — "how big is a terminal pane in this window?" A PTY is
///     created before its pane exists, so the spawn needs a guess. Without one
///     the shell starts at the 80×24 fallback and its login banner and first
///     prompt are wrapped for 80 columns; in a wider pane that output is
///     already mis-wrapped by the time the real size arrives, and a prompt that
///     redraws itself (powerlevel10k, starship) keeps painting over it.
///
/// The pane guess is persisted because the case that needs it most is a cold
/// launch — the first terminal, and every session in a restored workspace, is
/// spawned before any pane has mounted to report a size.

const STORAGE_KEY = "voidlink-terminal-grid";

export interface GridSize {
  cols: number;
  rows: number;
}

/// Keyed by ptyId. Only ever written with a size the PTY has actually been
/// told about, so it is the PTY's winsize and not merely the grid's.
const byPty = new Map<string, GridSize>();

let lastSize: GridSize | null = loadPersisted();

function loadPersisted(): GridSize | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GridSize>;
    const cols = parsed.cols ?? 0;
    const rows = parsed.rows ?? 0;
    return valid(cols, rows) ? { cols, rows } : null;
  } catch {
    return null;
  }
}

/// Sizes only ever come from xterm or from storage that xterm wrote, but a
/// hand-edited or truncated localStorage entry must not be able to hand the
/// backend a nonsense winsize.
function valid(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === "number" && typeof rows === "number" &&
    Number.isInteger(cols) && Number.isInteger(rows) &&
    cols > 0 && rows > 0
  );
}

/// Record the size a PTY was just resized to. Callers must only invoke this
/// once the resize has actually been handed to the backend — the whole value
/// of the per-PTY entry is that it describes the shell's view, not the grid's.
export function rememberGridSize(ptyId: string, cols: number, rows: number) {
  if (!valid(cols, rows)) return;
  byPty.set(ptyId, { cols, rows });
  lastSize = { cols, rows };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lastSize));
  } catch {
    // Private mode / quota — the in-memory value still serves this session.
  }
}

/// The winsize this PTY was last given, or `null` if we've never sized it.
export function sizeForPty(ptyId: string): GridSize | null {
  return byPty.get(ptyId) ?? null;
}

/// Drop a dead PTY's entry. Called when the shell exits — pane unmount must
/// *not* forget, since the point of the map is surviving a remount.
export function forgetPtySize(ptyId: string) {
  byPty.delete(ptyId);
}

/// Best guess at the size a new pane will have. Survives a restart; `null`
/// only before the very first terminal this install ever opened, where the
/// backend's own default is as good a guess as any.
export function lastGridSize(): GridSize | null {
  return lastSize;
}
