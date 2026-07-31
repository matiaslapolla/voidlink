/// Annotated diffs: a comment on a hunk, which the agent then reads.
///
/// Orca's mechanism, and the half of it that does not need orchestration. You
/// mark up a diff the way you would mark up someone else's pull request, and
/// the next agent turn in that repository gets your notes as context — so
/// "no, do it this way" is a thing you point at rather than a thing you have to
/// re-describe in prose.
///
/// ## The hard part is the anchor, and it is stated rather than hidden
///
/// A note is written against a hunk, and hunks are not stable objects. Edit
/// three lines above and every header below shifts; stage the hunk and it
/// leaves the unstaged diff entirely. There is no id to hold on to, because
/// the diff is *computed*, not stored.
///
/// So a note anchors on `(filePath, hunkHeader)` and, when that header is no
/// longer in the file's diff, becomes **detached** rather than lost. A detached
/// note still belongs to the file, still shows up, and still reaches the agent
/// — it just no longer claims to point at a specific hunk. The alternative
/// designs both fail worse: dropping the note silently destroys the user's
/// work, and pinning by index re-points the note at a *different* hunk, which
/// is worse than losing it because it looks correct.
///
/// Notes are per repository and never leave it. Deliberately not in the event
/// log: the log records what happened, and an unresolved note is a thing that
/// has *not* happened yet. Adding and resolving are recorded there; the note's
/// live state lives here.

import { createStore, produce } from "solid-js/store";
import { STORAGE_KEYS, readJson, writeJson } from "@/store/layout/persistence";
import { record } from "@/store/journal";

export interface ReviewNote {
  id: string;
  repo: string;
  filePath: string;
  /// The `@@ … @@` line the note was written against. The anchor — see the
  /// module comment for why it is this and not an index.
  hunkHeader: string;
  body: string;
  createdAt: number;
  /// A resolved note stays in the store and stops reaching the agent. Deleting
  /// on resolve would make "what did I already say about this file" an
  /// unanswerable question halfway through a review.
  resolved: boolean;
}

type NotesByRepo = Record<string, ReviewNote[]>;

function reviveNote(raw: unknown, repo: string): ReviewNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const body = typeof r.body === "string" ? r.body.trim() : "";
  const filePath = typeof r.filePath === "string" ? r.filePath : "";
  // An empty body is not a note, and a note with no file cannot be shown
  // anywhere — both are unrecoverable rather than repairable.
  if (!body || !filePath) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    repo,
    filePath,
    hunkHeader: typeof r.hunkHeader === "string" ? r.hunkHeader : "",
    body,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    resolved: !!r.resolved,
  };
}

export function reviveReviewNotes(raw: unknown): NotesByRepo {
  if (!raw || typeof raw !== "object") return {};
  const out: NotesByRepo = {};
  for (const [repo, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const notes = list
      .map((entry) => reviveNote(entry, repo))
      .filter((n): n is ReviewNote => n !== null);
    if (notes.length) out[repo] = notes;
  }
  return out;
}

const [notes, setNotes] = createStore<NotesByRepo>(
  reviveReviewNotes(readJson<unknown>(STORAGE_KEYS.reviewNotes, {})),
);

function persist(): void {
  writeJson(STORAGE_KEYS.reviewNotes, notes);
}

export function reviewNotesFor(repo: string): ReviewNote[] {
  return notes[repo] ?? [];
}

export function reviewNotesForFile(repo: string, filePath: string): ReviewNote[] {
  return reviewNotesFor(repo).filter((n) => n.filePath === filePath);
}

/// Unresolved notes across the repository — what the agent is given, and what
/// a badge counts.
export function openReviewNotes(repo: string): ReviewNote[] {
  return reviewNotesFor(repo).filter((n) => !n.resolved);
}

export interface AddNoteOptions {
  repo: string;
  filePath: string;
  hunkHeader: string;
  body: string;
  now?: number;
}

/// Attach a note to a hunk. Returns its id, or `null` for an empty body.
export function addReviewNote(options: AddNoteOptions): string | null {
  const body = options.body.trim();
  if (!body) return null;
  const note: ReviewNote = {
    id: crypto.randomUUID(),
    repo: options.repo,
    filePath: options.filePath,
    hunkHeader: options.hunkHeader,
    body,
    createdAt: options.now ?? Date.now(),
    resolved: false,
  };
  setNotes(
    produce((s) => {
      (s[options.repo] ??= []).push(note);
    }),
  );
  persist();
  record({
    kind: "review.note.added",
    actor: "user",
    repo: options.repo,
    subject: options.filePath,
    summary: `Commented on ${options.filePath}: “${firstLine(body)}”`,
    data: { noteId: note.id, filePath: options.filePath, hunkHeader: options.hunkHeader },
  });
  return note.id;
}

export function resolveReviewNote(repo: string, noteId: string, resolved = true): void {
  const note = reviewNotesFor(repo).find((n) => n.id === noteId);
  if (!note || note.resolved === resolved) return;
  setNotes(repo, (n) => n.id === noteId, "resolved", resolved);
  persist();
  record({
    kind: resolved ? "review.note.resolved" : "review.note.reopened",
    actor: "user",
    repo,
    subject: note.filePath,
    summary: resolved
      ? `Resolved a note on ${note.filePath}`
      : `Reopened a note on ${note.filePath}`,
    data: { noteId, filePath: note.filePath },
  });
}

export function removeReviewNote(repo: string, noteId: string): void {
  if (!reviewNotesFor(repo).some((n) => n.id === noteId)) return;
  setNotes(
    produce((s) => {
      const list = s[repo];
      if (!list) return;
      s[repo] = list.filter((n) => n.id !== noteId);
    }),
  );
  persist();
}

/// Test seam.
export function resetReviewNotes(): void {
  setNotes(produce((s) => {
    for (const key of Object.keys(s)) delete s[key];
  }));
  persist();
}

function firstLine(body: string, max = 60): string {
  const line = body.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ── Anchoring ────────────────────────────────────────────────────────────────

export interface AnchoredNotes {
  /// Hunk index → the notes written against that hunk's header.
  byHunk: Map<number, ReviewNote[]>;
  /// Notes whose hunk is no longer in this diff. Still the file's notes; they
  /// have simply lost their line of sight. See the module comment.
  detached: ReviewNote[];
}

/// Match a file's notes against the hunks it currently has.
///
/// Pure, and the load-bearing function in this module: it is where a note
/// either finds its hunk or is honestly reported as having lost it. Duplicate
/// headers — two hunks with identical `@@` lines, which happens in generated
/// files — all match, because showing a note twice is a smaller lie than
/// picking one of two identical anchors and pretending it was the intended one.
export function anchorNotes(
  fileNotes: readonly ReviewNote[],
  hunkHeaders: readonly string[],
): AnchoredNotes {
  const byHunk = new Map<number, ReviewNote[]>();
  const detached: ReviewNote[] = [];
  for (const note of fileNotes) {
    let matched = false;
    hunkHeaders.forEach((header, index) => {
      if (header !== note.hunkHeader) return;
      matched = true;
      const list = byHunk.get(index);
      if (list) list.push(note);
      else byHunk.set(index, [note]);
    });
    if (!matched) detached.push(note);
  }
  return { byHunk, detached };
}

/// The notes, as a prompt section. `null` when there is nothing to say.
///
/// Grouped by file and quoted verbatim. The instruction line matters as much as
/// the notes: without it a CLI reads them as background and answers *about*
/// them, when what the user meant was "do this".
export function reviewNotesPrompt(openNotes: readonly ReviewNote[]): string | null {
  if (openNotes.length === 0) return null;
  const byFile = new Map<string, ReviewNote[]>();
  for (const note of openNotes) {
    const list = byFile.get(note.filePath);
    if (list) list.push(note);
    else byFile.set(note.filePath, [note]);
  }
  const lines = [
    "The user has left the following review comments on the current diff. Treat them as instructions about what to change, not as background.",
  ];
  for (const [filePath, fileNotes] of byFile) {
    lines.push(`\n### ${filePath}`);
    for (const note of fileNotes) {
      if (note.hunkHeader) lines.push(`On \`${note.hunkHeader}\`:`);
      else lines.push("On this file (the hunk it was written against has since changed):");
      lines.push(`> ${note.body.split("\n").join("\n> ")}`);
    }
  }
  return lines.join("\n");
}
