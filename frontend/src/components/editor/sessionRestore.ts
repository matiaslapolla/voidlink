/// Per-file editor session state — where the cursor was, where the buffer was
/// scrolled, which regions were folded — kept per workspace.
///
/// Built on Monaco's own `saveViewState()` / `restoreViewState()` rather than
/// three hand-rolled fields. Three reasons: folds are held by a *contribution*
/// (`folding`) whose internal shape is not public API, so "which regions were
/// folded" cannot be reconstructed from outside; the view state also carries
/// the selection, the sticky-scroll position and the word-wrap column state,
/// which are exactly the things a user notices missing; and every future
/// contribution that persists something gets restored for free instead of
/// needing a fourth field here.
///
/// The trade is that the payload is opaque — we cannot inspect or migrate it.
/// That is handled by treating a decode failure as "no session": the worst case
/// is a file that opens at line 1, which is where it would open anyway.
///
/// Storage is per workspace so two repositories cannot fight over the same
/// paths, and capped so a long-lived install cannot grow an unbounded blob in
/// localStorage.

/// Monaco's `ICodeEditorViewState`, held opaquely. Typed as `unknown` on
/// purpose: this module persists it and hands it back, and the only place that
/// is allowed to know what is inside it is the call to `restoreViewState`.
export type ViewState = unknown;

export interface SessionEntry {
  path: string;
  state: ViewState;
  /// Epoch ms of the last write, used only to decide what to evict.
  at: number;
}

interface SessionPayload {
  version: 1;
  entries: SessionEntry[];
}

/// How many files keep a remembered position. Chosen to comfortably exceed any
/// realistic open-tab count while keeping the serialised blob small — view
/// states are a few hundred bytes each.
export const SESSION_LIMIT = 200;

const VERSION = 1;

export function sessionStorageKey(workspaceKey: string): string {
  return `voidlink-editor-session:${workspaceKey}`;
}

/// Newest-first, capped. Called on every write so the stored payload is always
/// already within the limit — pruning at read time would let a blob that grew
/// under an older limit stay big forever.
export function pruneEntries(entries: SessionEntry[], limit = SESSION_LIMIT): SessionEntry[] {
  return [...entries].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

export function encodeSession(entries: SessionEntry[]): string {
  const payload: SessionPayload = { version: VERSION, entries: pruneEntries(entries) };
  return JSON.stringify(payload);
}

/// Parse a stored payload back into entries.
///
/// Every failure mode — absent, unparseable, wrong version, wrong shape, a row
/// with a missing path — yields an empty list rather than throwing. A corrupt
/// session must cost the user a scroll position, never an editor that will not
/// open.
export function decodeSession(raw: string | null): SessionEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const payload = parsed as Partial<SessionPayload>;
  if (payload.version !== VERSION || !Array.isArray(payload.entries)) return [];
  const out: SessionEntry[] = [];
  for (const row of payload.entries) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Partial<SessionEntry>;
    if (typeof entry.path !== "string" || entry.path === "") continue;
    if (entry.state === undefined || entry.state === null) continue;
    out.push({ path: entry.path, state: entry.state, at: typeof entry.at === "number" ? entry.at : 0 });
  }
  return pruneEntries(out);
}

/// The subset of `Storage` this needs, so the store is testable against a plain
/// object and works in a window where localStorage throws (private mode, quota).
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/// One workspace's remembered positions.
///
/// Reads are synchronous from an in-memory map hydrated once on construction —
/// restoring a view state happens inside a model swap, and a JSON parse per tab
/// switch is a cost with no upside. Writes are coalesced: switching through ten
/// tabs writes once, not ten times.
export class EditorSessionStore {
  private entries = new Map<string, SessionEntry>();
  private key: string;
  private storage: SessionStorage | null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceKey: string, storage: SessionStorage | null = safeLocalStorage()) {
    this.key = sessionStorageKey(workspaceKey);
    this.storage = storage;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    for (const entry of decodeSession(raw)) this.entries.set(entry.path, entry);
  }

  /// Remember `state` for `path`. A `null` state (Monaco returns one for an
  /// editor with no model) forgets the entry instead of storing a hole.
  save(path: string, state: ViewState) {
    if (state === null || state === undefined) {
      this.entries.delete(path);
    } else {
      this.entries.set(path, { path, state, at: Date.now() });
    }
    this.scheduleFlush();
  }

  restore(path: string): ViewState | null {
    return this.entries.get(path)?.state ?? null;
  }

  /// Write now. Called on teardown, where a pending timer would never fire.
  flush() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, encodeSession([...this.entries.values()]));
    } catch {
      // Quota or a private-mode window. The feature degrades to "positions last
      // for this session", which is worth more than an exception on tab switch.
    }
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }
}

const FLUSH_DELAY_MS = 400;

function safeLocalStorage(): SessionStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
