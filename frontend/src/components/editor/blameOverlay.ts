/// Inline `git blame`, in two forms over one cache.
///
///   1. **The whole-file overlay** — an injected annotation at the end of every
///      line, GitLens style. Toggled by `view.toggle-blame`.
///   2. **The caret-line readout** in the editor's own status bar, which asks
///      the cache what the cursor is sitting on and offers to reveal the commit.
///
/// Both read the same per-file entry, so the second costs no IPC. That is the
/// whole reason the cache is here rather than inside the overlay's refresh: the
/// status chip updates on every cursor move, and a chip that fetched would be a
/// `git_blame_file` per arrow key.
///
/// ## Why the cache is keyed the way it is
///
/// `refreshBlameFor` used to be called on every controller notification, which
/// is every keystroke (100ms debounced) and *twice* per save — each one a full
/// `git_blame_file` plus a rebuild of every line's decoration. On a 5k-line file
/// that is three blames of the whole file to save one character.
///
/// Blame only actually changes when one of two things happens: the repo's
/// history moves, or the file on disk changes. So the key is
/// `<refs epoch>:<model version>`:
///
///   • **refs epoch** is bumped by `invalidateAllBlame()`, wired to the
///     `voidlink:refresh-git` pulse. That covers commit, checkout, rebase,
///     amend — including one performed in another window, since
///     `bridgeGitRefsAcrossWindows` re-raises those locally.
///   • **model version** is Monaco's version id, read only while the buffer is
///     *clean*. A dirty buffer reuses whatever is cached for the current epoch:
///     the annotations ride along with Monaco's own decoration tracking as lines
///     shift, and re-blaming mid-edit would answer about the file on disk
///     anyway. Saving flips dirty off at a new version id, which is exactly one
///     new key — so exactly one blame per save, however many times the
///     controller notifies.
///
/// A repo head oid would be the more literal key, but it costs an extra IPC per
/// check to learn something the refs pulse already tells us for free.
import { createSignal } from "solid-js";
import { gitApi } from "@/api/git";
import { onBlameEnabled, publishBlameEnabled } from "@/api/windows";
import { editorController } from "@/components/editor/editorController";
import type { BlameLine } from "@/types/git";
import type * as Monaco from "monaco-editor";

/// Global enable state, persisted in localStorage so the user's preference
/// survives reloads. Single signal so every surface in the window stays in sync
/// without prop drilling — and broadcast, so every *window* does too.
const STORAGE_KEY = "voidlink-blame-enabled";

const initialEnabled = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
})();

const [enabled, setEnabled] = createSignal(initialEnabled);

export function blameEnabled() {
  return enabled();
}

/// Repo path resolver supplied by the App at startup. Without it we'd need every
/// blame call site to know the active workspace's repo; the resolver decouples
/// this module from the store.
let repoPathResolver: (filePath: string) => string | null = () => null;

/// The live controller subscription and cross-window listener, so a second
/// `configureBlame` replaces them instead of stacking a duplicate. It is called
/// from a component body (`EditorSurface`), and a remount used to leave the old
/// subscription running — two subscribers meaning two blames per notification.
let teardown: (() => void) | null = null;

/// Point blame at a repo and start following the editor. Returns a disposer;
/// calling it again replaces the previous wiring.
export function configureBlame(
  resolver: (filePath: string) => string | null,
): () => void {
  repoPathResolver = resolver;
  teardown?.();

  // Subscribe to editor model changes — when the user switches tabs or a file
  // model finishes loading, refresh blame for the now-active path. This handles
  // the race where the surface's effect fires before `openFile` has registered
  // the model. Cheap now: a notification whose cache key is unchanged does no
  // IPC and rebuilds no decorations.
  const unsubEditor = editorController.subscribe((_files, activePath) => {
    if (!activePath) return;
    if (enabled()) {
      const repo = repoPathResolver(activePath);
      if (repo) void refreshBlameFor(repo, activePath);
    } else {
      clearBlameFor(activePath);
    }
  });

  // Follow the toggle in other windows. `applyEnabled` rather than
  // `setBlameEnabled` because a handler that re-published would ping-pong with
  // the sender forever — see `onSourced` in `api/windows.ts`.
  let unsubWindows: (() => void) | null = null;
  let disposed = false;
  void onBlameEnabled((v) => applyEnabled(v)).then((fn) => {
    if (disposed) fn();
    else unsubWindows = fn;
  });

  teardown = () => {
    disposed = true;
    unsubEditor();
    unsubWindows?.();
  };
  return () => {
    if (teardown) {
      teardown();
      teardown = null;
    }
  };
}

/// Apply an enable/disable to this window: persist it and re-run the overlay for
/// whatever is in front, so the toggle feels instant rather than waiting for the
/// next tab switch.
function applyEnabled(v: boolean) {
  if (v === enabled()) return;
  setEnabled(v);
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    // ignore quota errors — feature works without persistence
  }
  const active = editorController.getActivePath();
  if (!active) return;
  if (v) {
    const repo = repoPathResolver(active);
    if (repo) void refreshBlameFor(repo, active);
  } else {
    clearBlameFor(active);
  }
}

export function setBlameEnabled(v: boolean) {
  if (v === enabled()) return;
  applyEnabled(v);
  void publishBlameEnabled(v);
}

export function toggleBlame() {
  setBlameEnabled(!enabled());
}

// ── The cache ───────────────────────────────────────────────────────────────

/// What blame for one file currently is, and what state that is in. `undefined`
/// for a path means "never asked"; the chip and the overlay both need to tell
/// that apart from "asked, and there is none" (see `BlameStatus`).
interface BlameEntry {
  /// `<refs epoch>:<model version | "dirty">` — see the module header.
  key: string;
  lines: BlameLine[];
  byLine: Map<number, BlameLine>;
  /// The message from a failed `git_blame_file`, or `null` on success. Kept
  /// rather than logged: "there is no blame for this file" and "blame is off"
  /// used to be the same empty chip.
  error: string | null;
}

const cache = new Map<string, BlameEntry>();

/// Bumped on every cache mutation. The cache is a plain `Map` — deliberately, it
/// is read per cursor move and a store would be reactive overhead for data
/// nobody diffs — so this is the one reactive handle on it. The status-bar chip
/// tracks it to learn that a fetch landed; without it the chip would show the
/// caret's blame only from the *second* cursor move after a load.
const [revision, setRevision] = createSignal(0);

export const blameRevision = revision;

function touched() {
  setRevision((r) => r + 1);
}

/// Active decoration ids per file path, so refreshing one file doesn't wipe
/// another's overlay.
const activeDecorations = new Map<string, string[]>();
const inflight = new Map<string, Promise<BlameEntry>>();

/// Bumped whenever the repo's history could have moved. Every cache key embeds
/// it, so one increment invalidates every file at once without walking the map.
let refsEpoch = 0;

/// Invalidate every file's blame and re-run the overlay for what is in front.
///
/// Wired to the git-refs pulse. Without it, committing the open file left the
/// annotations reading `• You · Uncommitted` until the user switched tabs and
/// back — the file's blame had genuinely changed and nothing said so.
export function invalidateAllBlame(): void {
  refsEpoch += 1;
  cache.clear();
  touched();
  if (!enabled()) return;
  const active = editorController.getActivePath();
  if (!active) return;
  const repo = repoPathResolver(active);
  if (repo) void refreshBlameFor(repo, active);
}

function isDirty(filePath: string): boolean {
  return editorController.getOpenFiles().some((f) => f.path === filePath && f.dirty);
}

/// The cache key for a file's *current* git-visible state. `null` when there is
/// no model, which means there is nothing to key against yet.
function stateKey(filePath: string): string | null {
  const model = editorController.getModel(filePath);
  if (!model) return null;
  // A dirty buffer keys on the epoch alone: its on-disk content has not moved
  // since the last blame, so the cached answer is still the right one.
  if (isDirty(filePath)) return `${refsEpoch}:dirty`;
  return `${refsEpoch}:${model.getVersionId()}`;
}

/// Whether a cached entry still answers for `key`. A dirty buffer accepts any
/// entry from the same epoch, because the edit it is carrying is not something
/// git has an opinion about yet.
function entryAnswers(entry: BlameEntry, key: string): boolean {
  if (entry.key === key) return true;
  return key.endsWith(":dirty") && entry.key.startsWith(`${refsEpoch}:`);
}

export type BlameStatus =
  /// The feature is switched off. Nothing was attempted.
  | "off"
  /// Never looked at this file.
  | "unknown"
  /// A `git_blame_file` is in flight.
  | "loading"
  /// git could not blame it — not committed, ignored, outside the repo. The
  /// reason is in `blameErrorFor`.
  | "unavailable"
  | "ready";

export function blameStatusFor(filePath: string): BlameStatus {
  if (!enabled()) return "off";
  if (inflight.has(filePath)) return "loading";
  const entry = cache.get(filePath);
  if (!entry) return "unknown";
  if (entry.error) return "unavailable";
  return entry.lines.length > 0 ? "ready" : "unavailable";
}

/// Why blame is unavailable for this file, verbatim from git. `null` when there
/// is no error to report.
export function blameErrorFor(filePath: string): string | null {
  return cache.get(filePath)?.error ?? null;
}

/// The blame entry for one line, or `undefined` if there is none. What the
/// status-bar chip reads on every cursor move — a map lookup, no IPC.
export function blameLineFor(filePath: string, line: number): BlameLine | undefined {
  return cache.get(filePath)?.byLine.get(line);
}

/// Test seam and "reset" escape hatch: forget everything without touching the
/// enable state or the decorations.
export function resetBlameCache(): void {
  cache.clear();
  inflight.clear();
  refsEpoch += 1;
  touched();
}

// ── Formatting ──────────────────────────────────────────────────────────────

const REL_DAY = 86_400;
const REL_HOUR = 3_600;
const REL_MIN = 60;

export function relTime(seconds: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - seconds);
  if (diff < REL_MIN) return "just now";
  if (diff < REL_HOUR) return `${Math.floor(diff / REL_MIN)}m ago`;
  if (diff < REL_DAY) return `${Math.floor(diff / REL_HOUR)}h ago`;
  if (diff < REL_DAY * 30) return `${Math.floor(diff / REL_DAY)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

/// Who wrote a line. Uncommitted hunks used to be hardcoded to "You", which
/// threw away the signature git2 actually returned — and was a lie in a worktree
/// with a per-repo `user.name`, or on a line staged by someone else's patch.
export function blameAuthor(line: BlameLine): string {
  return line.authorName || (line.uncommitted ? "You" : "?");
}

function annotationText(line: BlameLine): string {
  // Leading non-breaking space pads the annotation away from the code's last
  // character. Monaco strips a normal space at the edge of injected text.
  const lead = "   ";
  if (line.uncommitted) return `${lead}• ${blameAuthor(line)} · Uncommitted`;
  return `${lead}${line.shortOid} · ${blameAuthor(line)} · ${relTime(line.time)} · ${line.summary}`;
}

// ── The overlay ─────────────────────────────────────────────────────────────

async function fetchBlame(
  repoPath: string,
  filePath: string,
  key: string,
): Promise<BlameEntry> {
  let promise = inflight.get(filePath);
  if (!promise) {
    promise = gitApi
      .blameFile(repoPath, filePath)
      .then((lines): BlameEntry => ({
        key,
        lines,
        byLine: new Map(lines.map((l) => [l.line, l])),
        error: null,
      }))
      .catch((e: unknown): BlameEntry => ({
        // Files outside the repo, never committed, or .gitignored land here.
        // Expected, so no overlay — but the reason is kept for the chip's
        // tooltip rather than thrown away into `console.debug`.
        key,
        lines: [],
        byLine: new Map(),
        error: e instanceof Error ? e.message : String(e),
      }))
      .finally(() => inflight.delete(filePath));
    inflight.set(filePath, promise);
    // `loading` is a state the chip renders, so entering it is a change too.
    touched();
  }
  const entry = await promise;
  cache.set(filePath, entry);
  touched();
  return entry;
}

/// Apply blame decorations to the editor for `filePath`. If the model isn't
/// loaded yet we wait one frame and retry once — this covers the race between
/// activeItem flipping and `editorController.openFile` finishing.
export async function refreshBlameFor(repoPath: string, filePath: string) {
  if (!enabled()) {
    clearBlameFor(filePath);
    return;
  }
  const monaco = editorController.getMonaco();
  if (!monaco || !editorController.getEditor()) return;
  let model = editorController.getModel(filePath);
  if (!model) {
    await new Promise((r) => requestAnimationFrame(r));
    model = editorController.getModel(filePath);
    if (!model) return;
  }
  const liveModel = model;

  const key = stateKey(filePath);
  if (!key) return;
  const cached = cache.get(filePath);
  // The whole point of the cache: nothing about this file's git state has moved,
  // so neither the fetch nor the decoration rebuild is worth doing.
  if (cached && entryAnswers(cached, key) && activeDecorations.has(filePath)) return;

  const entry = cached && entryAnswers(cached, key)
    ? cached
    : await fetchBlame(repoPath, filePath, key);

  // Re-check after the await. The user may have toggled blame off, switched to
  // another file, or closed this one — three ways to end up decorating a model
  // nobody asked about. The model identity check is the strict one: a file
  // closed and reopened has a *new* model, and painting the old one leaks.
  if (!enabled()) {
    clearBlameFor(filePath);
    return;
  }
  if (editorController.getModel(filePath) !== liveModel) return;
  if (entry.error || entry.lines.length === 0) {
    clearBlameFor(filePath);
    return;
  }

  // Inject `after` content at the END of each line so the annotation renders as
  // a trailing comment (GitLens style). A zero-width range at column 1 would
  // inject BEFORE the line content and push code rightward.
  const lineCount = liveModel.getLineCount();
  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
  for (const b of entry.lines) {
    // A blame computed against the file on disk can name lines an edited buffer
    // no longer has. `getLineMaxColumn` throws on those.
    if (b.line < 1 || b.line > lineCount) continue;
    const maxCol = liveModel.getLineMaxColumn(b.line);
    decorations.push({
      range: new monaco.Range(b.line, maxCol, b.line, maxCol),
      options: {
        after: {
          content: annotationText(b),
          inlineClassName: b.uncommitted
            ? "voidlink-blame voidlink-blame-uncommitted"
            : "voidlink-blame",
        },
      },
    });
  }

  setDecorations(liveModel, filePath, decorations);
}

/// Swap one file's decorations, in a single batched model change.
///
/// Goes through the model's `deltaDecorations` rather than the editor's
/// `createDecorationsCollection`: a collection is scoped to one editor and is
/// dropped when that editor's model changes, and blame has to survive both — a
/// split shows the same model in two groups, and both need the annotations.
/// Model-level decorations reach every editor attached to the model.
function setDecorations(
  model: Monaco.editor.ITextModel,
  filePath: string,
  decorations: Monaco.editor.IModelDeltaDecoration[],
) {
  const prev = activeDecorations.get(filePath) ?? [];
  const next = model.deltaDecorations(prev, decorations);
  if (next.length === 0) activeDecorations.delete(filePath);
  else activeDecorations.set(filePath, next);
}

export function clearBlameFor(filePath: string) {
  const prev = activeDecorations.get(filePath);
  // Drop the map entry unconditionally. It used to return early when the model
  // was gone or the list was empty, leaving the path in the map forever — one
  // leaked entry per file opened while blame was off.
  activeDecorations.delete(filePath);
  if (!prev?.length) return;
  const model = editorController.getModel(filePath);
  if (!model) return;
  model.deltaDecorations(prev, []);
}

export function clearAllBlame() {
  for (const path of [...activeDecorations.keys()]) clearBlameFor(path);
}
