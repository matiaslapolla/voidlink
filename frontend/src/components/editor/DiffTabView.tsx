/// A working-tree diff, rendered as a Monaco side-by-side editor.
///
/// The workbench's git sidebar and compare tabs keep using
/// `components/git/shared/SplitDiffRenderer.tsx`: it renders straight from git
/// hunks, which is what you want for per-hunk staging in a 300px column. In the
/// editor window a diff gets the whole surface and sits next to real editors, so
/// it uses the same engine they do — matching gutters, matching scrolling,
/// matching syntax highlighting, and inline/side-by-side for free.
///
/// Monaco wants two whole documents, so the HEAD side is reconstructed from the
/// hunks (see `diffModel.ts`) rather than fetched — there is no "read file at
/// ref" command, and the reconstruction is exact.

import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  Columns2,
  GitCompare,
  RotateCw,
  Rows3,
  Hash,
  Image as ImageIcon,
  Space,
  SplitSquareVertical,
  Trash2,
  Plus,
} from "lucide-solid";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { fsApi } from "@/api/fs";
import { gitApi } from "@/api/git";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { useAppStore } from "@/store/LayoutContext";
import {
  DiffRenderer,
  type HunkActions,
} from "@/components/git/shared/SplitDiffRenderer";
import { ImageDiffView } from "@/components/git/shared/ImageDiffView";
import { bytesFromBase64, imageKindFromPath, planImageDiff } from "@/components/git/shared/imageDiff";
import { ProvenanceNote } from "@/components/git/shared/ProvenanceNote";
import { loadFileProvenance } from "@/components/git/shared/provenance";
import {
  applyLineClick,
  buildLineSelectionDiff,
  type LineSelection,
} from "@/components/git/shared/linePatch";
import { workingTreeSides } from "./diffModel";
import { MonacoDiffPane } from "./MonacoPanes";
import type { FileDiff } from "@/types/git";

interface DiffTabViewProps {
  repoPath: string;
  filePath: string;
  /// Which side of the index to show: `true` is `git diff --cached`, `false` is
  /// `git diff`. The sidebar decides it from the section the row was in.
  staged?: boolean;
}

export function DiffTabView(props: DiffTabViewProps) {
  const { state, actions } = useAppStore();
  const [busy, setBusy] = createSignal(false);

  /// Path as git names it — relative to the repo root. The staging commands
  /// take repo-relative paths, and so do the `FileDiff` entries we match
  /// against. The tab may carry either form depending on who opened it.
  const relPath = () =>
    props.filePath.startsWith(`${props.repoPath}/`)
      ? props.filePath.slice(props.repoPath.length + 1)
      : props.filePath;

  /// Path as the filesystem names it.
  ///
  /// `fs_read_file` takes a real path, but the git sidebar opens diffs with
  /// `entry.path()` straight from git2, which is repo-relative. The read
  /// therefore failed and the `catch` below turned that into an empty string —
  /// so Monaco was handed a blank working document and rendered the whole file
  /// as deleted. Silent, because a file that genuinely cannot be read has to
  /// stay non-fatal: a diff of a file deleted in the working tree is a real
  /// thing to want to look at.
  const absPath = () =>
    props.filePath.startsWith("/") ? props.filePath : `${props.repoPath}/${props.filePath}`;

  /// Refetched together: the diff decides which lines changed, the working file
  /// supplies the text those line numbers point into. Reading them separately
  /// would let one refresh land against the other's file version.
  const [data, { refetch }] = createResource(
    () => ({
      repo: props.repoPath,
      rel: relPath(),
      abs: absPath(),
      staged: props.staged ?? false,
      // Part of the request, not of the render: filtering the answer afterwards
      // left the header counts describing a different diff from the body.
      ignoreWhitespace: state.ignoreWhitespace,
    }),
    async ({ repo, rel, abs, staged, ignoreWhitespace }) => {
      const [diff, working] = await Promise.all([
        gitApi.diffWorking(repo, staged, ignoreWhitespace),
        fsApi.readFile(abs).catch(() => ""),
      ]);
      const fileDiff = diff.files.find((f) => (f.newPath ?? f.oldPath) === rel) ?? null;
      return { fileDiff, working };
    },
  );

  /// Anything that moves the index or the working tree invalidates this diff,
  /// and most of what moves them happens somewhere else — the sidebar's Stage
  /// button, a commit, a checkout, another window. Without this the tab only
  /// ever refreshed on its own two buttons, which is why staging from the
  /// sidebar appeared to leave the diff untouched.
  /// Who the journal thinks last wrote this file — file-level and inferred, and
  /// the note says both. See `git/shared/provenance.ts` for why no hunk-level
  /// claim is available to make here.
  ///
  /// Separate from the diff resource rather than folded into it: a failure to
  /// answer "who" must not be able to take the diff down with it, which is the
  /// same reason `record()` cannot throw. `null` on rejection means the note
  /// simply does not render.
  const [provenance, { refetch: refetchProvenance }] = createResource(
    () => ({ repo: props.repoPath, abs: absPath() }),
    ({ repo, abs }) => loadFileProvenance(repo, abs).catch(() => null),
  );

  onMount(() =>
    onCleanup(
      onGitRefsChanged(() => {
        void refetch();
        void refetchBinary();
        // The mtime the claim rests on moves whenever the file does, so a stale
        // attribution would keep naming the agent that wrote the *previous*
        // version — §7.5.4's stale-value failure, with a name attached.
        void refetchProvenance();
      }),
    ),
  );

  /// Exactly what the backend returned. Nothing filters it here any more,
  /// which is also what makes hunk indices safe to send back: the renderer
  /// iterates the same array Rust will index into.
  const fileDiff = createMemo<FileDiff | null>(() => data()?.fileDiff ?? null);

  // ── Image diffs ───────────────────────────────────────────────────────
  //
  // Fetched separately from the diff, and only when the *path* claims to be an
  // image: base64-encoding a side costs real bytes, and asking for them on
  // every text file would pay that cost on every diff in the app to answer a
  // question the filename already answers.

  const [binary, { refetch: refetchBinary }] = createResource(
    () => {
      const claimed = imageKindFromPath(relPath());
      if (!claimed) return null;
      return {
        repo: props.repoPath,
        rel: relPath(),
        oldBlobOid: fileDiff()?.oldBlobOid ?? null,
        fromWorkdir: !(props.staged ?? false),
      };
    },
    (k) => gitApi.binarySides(k.repo, k.rel, k.oldBlobOid, k.fromWorkdir).catch(() => null),
  );

  /// Whether this file can be *drawn*, as opposed to merely being named like
  /// an image. Both sides are sniffed — see `imageDiff.ts`. `null` means fall
  /// back to the ordinary renderer, which for a real binary is the placeholder
  /// and for a mislabelled `.png` is exactly the right answer.
  const imagePlan = createMemo(() => {
    const sides = binary();
    if (!sides) return null;
    return planImageDiff(
      relPath(),
      sides.old ? bytesFromBase64(sides.old.base64) : null,
      sides.new ? bytesFromBase64(sides.new.base64) : null,
    );
  });

  /// SVG is an image *and* a text file, so it gets both views and this decides
  /// which is showing. Defaults to the picture: that is what changed.
  const [preferText, setPreferText] = createSignal(false);
  const showingImage = () => imagePlan() !== null && !preferText();

  /// Per-hunk view. Local rather than a stored preference: you turn it on for
  /// the file you are splitting up, not forever.
  const [hunkMode, setHunkMode] = createSignal(false);

  /// The lines picked inside one hunk, and where a shift-click ranges from.
  ///
  /// Cleared on every refetch: the selection names positions in a `FileDiff`
  /// that has just been replaced, and a stale index would send the next click
  /// at whatever line happens to sit there now. That is the failure this
  /// feature exists to not have.
  const [selection, setSelection] = createSignal<LineSelection | null>(null);
  const [anchor, setAnchor] = createSignal<number | null>(null);

  function clearSelection() {
    setSelection(null);
    setAnchor(null);
  }

  /// What the selection's indices are indices *into*, as a value that only
  /// changes when the lines do.
  ///
  /// Not the resource object: this tab refetches on every refs pulse — several
  /// a second while an agent is running — and clearing on each of those would
  /// take the selection out from under a user who is halfway through making
  /// it. Clearing on a genuine content change is the part that matters, since
  /// after one the indices point at whatever now sits in those positions.
  const hunkFingerprint = createMemo(() =>
    (fileDiff()?.hunks ?? [])
      .map((h) => `${h.header}\u0000${h.lines.map((l) => l.origin + l.content).join("\u0001")}`)
      .join("\u0002"),
  );

  createEffect(on(hunkFingerprint, () => clearSelection(), { defer: true }));

  function pickLine(hunkIndex: number, lineIndex: number, shift: boolean) {
    const file = fileDiff();
    const hunk = file?.hunks[hunkIndex];
    if (!hunk) return;
    const next = applyLineClick(selection(), anchor(), hunk, hunkIndex, lineIndex, shift);
    setSelection(next.selection);
    setAnchor(next.anchor);
  }

  /// The diff a hunk action should be sent, and the hunk index inside it.
  ///
  /// With a selection in this hunk, that is a one-hunk `FileDiff` narrowed to
  /// the picked lines (see `linePatch.ts`); without one it is the real diff at
  /// the real index. `null` means the selection could not be turned into a
  /// patch — refused rather than quietly widened to the whole hunk.
  function target(
    hunkIndex: number,
    direction: "forward" | "reverse",
  ): { file: FileDiff; index: number } | null {
    const file = fileDiff();
    if (!file) return null;
    const sel = selection();
    if (!sel || sel.hunkIndex !== hunkIndex || sel.lines.length === 0) {
      return { file, index: hunkIndex };
    }
    const narrowed = buildLineSelectionDiff(file, hunkIndex, sel.lines, direction);
    if (!narrowed) return null;
    return { file: narrowed, index: 0 };
  }

  /// Stage or unstage one hunk.
  ///
  /// The index is positional in `file.hunks`, and Rust indexes the same array
  /// out of the `FileDiff` we hand it — so the two cannot disagree. (They used
  /// to: the whitespace filter dropped hunks client-side, and the dead
  /// `GitDiffView` carried a whole remap to undo that. Moving whitespace into
  /// the diff deleted the problem rather than the workaround.)
  async function stageHunk(hunkIndex: number) {
    const staged = props.staged ?? false;
    // Unstaging is the reverse direction, so the selection has to be narrowed
    // against the *new* side. Passing the wrong one here is the whole bug
    // `linePatch.ts` is written to make impossible to write by accident.
    const t = target(hunkIndex, staged ? "reverse" : "forward");
    if (!t) {
      pushToast("Those lines cannot be staged on their own — use the whole hunk.", "warning");
      return;
    }
    const picked = t.index === 0 && t.file !== fileDiff() ? (selection()?.lines.length ?? 0) : 0;
    await run(staged ? "Could not unstage hunk" : "Could not stage hunk", async () => {
      await gitApi.applyHunk(props.repoPath, t.file, t.index, staged);
      const what = picked > 0 ? `${picked} line${picked === 1 ? "" : "s"}` : "hunk";
      pushToast(`${staged ? "Unstaged" : "Staged"} ${what}`, "success", 1800);
      clearSelection();
    });
  }

  /// Revert one hunk in the working tree. Irreversible, so it asks — and Rust
  /// refuses outright if the file moved since this diff was rendered.
  async function discardHunk(hunkIndex: number) {
    // Discard un-applies against the working tree, which holds the new side.
    const t = target(hunkIndex, "reverse");
    if (!t) {
      pushToast("Those lines cannot be discarded on their own — use the whole hunk.", "warning");
      return;
    }
    const picked = t.index === 0 && t.file !== fileDiff() ? (selection()?.lines.length ?? 0) : 0;
    const what = picked > 0 ? `${picked} selected line${picked === 1 ? "" : "s"}` : "this hunk";
    const ok = await dialogConfirm(
      `Discard ${what} in ${relPath()}? Only those lines revert, and this cannot be undone.`,
      { title: picked > 0 ? "Discard lines" : "Discard hunk", kind: "warning" },
    );
    if (!ok) return;
    await run("Could not discard hunk", async () => {
      await gitApi.discardHunk(props.repoPath, t.file, t.index);
      pushToast(picked > 0 ? `Discarded ${what}` : "Discarded hunk", "info", 2200);
      clearSelection();
    });
  }

  const hunkActions = (): HunkActions => ({
    onStageHunk: (i) => void stageHunk(i),
    stageLabel: props.staged ? "Unstage hunk" : "Stage hunk",
    stageReverse: props.staged ?? false,
    // Discard only makes sense against the working tree. On the staged view
    // the working tree is not what you are looking at, so offering it there
    // would revert something off screen.
    onDiscardHunk: props.staged ? undefined : (i) => void discardHunk(i),
    selection: selection(),
    onLineClick: pickLine,
    onClearSelection: clearSelection,
  });

  const sides = createMemo(() => {
    const d = data();
    if (!d) return null;
    return workingTreeSides(d.working, fileDiff());
  });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      refetch();
      emitGitRefsChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Rust refuses a hunk action when the file has moved since this diff was
      // rendered — a checkout in the terminal, another editor saving. That is
      // not an error to apologise for, it is a stale view: say so, and refresh
      // so the next click acts on what is actually there.
      if (msg.includes("[stale-diff]")) {
        pushToast(
          "This file changed since the diff was drawn — refreshed. Try again.",
          "warning",
          5000,
        );
        refetch();
      } else {
        pushToast(`${label}: ${msg}`, "error", 6000);
      }
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    const ok = await dialogConfirm(
      `Discard changes to ${relPath()}? The file is reverted in the working tree and this cannot be undone.`,
      { title: "Discard changes", kind: "warning" },
    );
    if (!ok) return;
    await run("Could not discard", async () => {
      await gitApi.discardFile(props.repoPath, relPath());
      pushToast(`Discarded changes to ${relPath()}`, "info", 2500);
    });
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <GitCompare class="w-3.5 h-3.5 text-info shrink-0" />
        <div class="flex-1 min-w-0 text-body truncate">
          <span class="font-medium">{relPath()}</span>
          <Show when={fileDiff()}>
            {(f) => (
              <span class="ml-2 text-muted-foreground tabular-nums">
                <span class="text-success">+{f().additions}</span>{" "}
                <span class="text-destructive">-{f().deletions}</span>
              </span>
            )}
          </Show>
        </div>

        <button
          onClick={() =>
            void run("Could not stage", async () => {
              await gitApi.stageFiles(props.repoPath, [relPath()]);
              pushToast(`Staged ${relPath()}`, "success", 1800);
            })
          }
          disabled={busy()}
          class="flex items-center gap-1 px-2 py-0.5 text-label rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40 transition-colors"
          title="Stage the whole file"
        >
          <Plus class="w-3 h-3" />
          Stage
        </button>
        <button
          onClick={() => void discard()}
          disabled={busy()}
          class="flex items-center gap-1 px-2 py-0.5 text-label rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-40 transition-colors"
          title="Discard working-tree changes to this file"
        >
          <Trash2 class="w-3 h-3" />
          Discard
        </button>

        <button
          onClick={() => refetch()}
          aria-label="Refresh diff"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="Refresh diff"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        {/* Per-hunk staging lives behind this, because it needs a surface that
            draws hunks as discrete blocks — Monaco's diff view has no such
            unit. The controls existed and were rendered by nothing: their one
            caller had no import site anywhere in the tree. */}
        {/* Only for a file that has both readings — an SVG. A PNG has no text
            diff to switch to and a `.rs` has no picture, so in both of those
            the control would be a choice with one option. */}
        <Show when={imagePlan()?.hasTextDiff}>
          <button
            onClick={() => setPreferText((v) => !v)}
            aria-label="Toggle image and text view"
            aria-pressed={showingImage()}
            class={`flex items-center gap-1 px-2 py-0.5 text-label rounded border transition-colors ${
              showingImage()
                ? "bg-primary/15 border-primary/40 text-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="This file is both a picture and text — switch between them"
          >
            <ImageIcon class="w-3 h-3" />
            {showingImage() ? "Image" : "Text"}
          </button>
        </Show>
        <button
          onClick={() => setHunkMode((v) => !v)}
          aria-label="Toggle per-hunk view"
          aria-pressed={hunkMode()}
          class={`flex items-center gap-1 px-2 py-0.5 text-label rounded border transition-colors ${
            hunkMode()
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title={
            props.staged
              ? "Show hunks, with per-hunk unstage"
              : "Show hunks, with per-hunk stage and discard"
          }
        >
          <SplitSquareVertical class="w-3 h-3" />
          Hunks
        </button>
        <button
          onClick={() => actions.toggleDiffLineNumbers()}
          aria-label="Toggle line numbers"
          aria-pressed={state.diffLineNumbers}
          class={`flex items-center gap-1 px-2 py-0.5 text-label rounded border transition-colors ${
            state.diffLineNumbers
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title="Show old/new line numbers in the diff gutters"
        >
          <Hash class="w-3 h-3" />
          Lines
        </button>
        <button
          onClick={() => actions.toggleIgnoreWhitespace()}
          aria-label="Toggle ignore whitespace"
          aria-pressed={state.ignoreWhitespace}
          class={`flex items-center gap-1 px-2 py-0.5 text-label rounded border transition-colors ${
            state.ignoreWhitespace
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title="Ignore whitespace-only changes"
        >
          <Space class="w-3 h-3" />
          Ignore WS
        </button>
        <div
          role="group"
          aria-label="Diff view mode"
          class="flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <button
            onClick={() => actions.setDiffMode("inline")}
            aria-label="Inline (unified) view"
            aria-pressed={state.diffMode === "inline"}
            class={`flex items-center gap-1 px-2 py-0.5 text-label rounded transition-colors ${
              state.diffMode === "inline"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Inline (unified)"
          >
            <Rows3 class="w-3 h-3" />
            Inline
          </button>
          <button
            onClick={() => actions.setDiffMode("split")}
            aria-label="Split (side by side) view"
            aria-pressed={state.diffMode === "split"}
            class={`flex items-center gap-1 px-2 py-0.5 text-label rounded transition-colors ${
              state.diffMode === "split"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Side by side"
          >
            <Columns2 class="w-3 h-3" />
            Split
          </button>
        </div>
      </div>

      {/* Above the body rather than inside the renderer: the claim is about the
          file, and a row that scrolled with the hunks would be read as being
          about whichever hunk it happened to sit beside. */}
      <ProvenanceNote provenance={provenance()} />

      <div class="flex-1 min-h-0 relative">
        <Show when={showingImage()}>
          {/* Keyed on the plan, so switching files rebuilds the view rather
              than leaving the previous image's swipe position on the new one. */}
          <ImageDiffView
            plan={imagePlan()!}
            old={binary()?.old ?? null}
            new={binary()?.new ?? null}
            oversize={binary()?.oversize}
          />
        </Show>
        <Show when={!showingImage()}>
        <Show when={!hunkMode()} fallback={
          <div class="h-full overflow-auto scrollbar-thin font-mono text-body leading-[1.5]">
            <Show
              when={fileDiff()}
              fallback={
                <div class="h-full flex items-center justify-center text-muted-foreground text-body">
                  <Show when={data.loading} fallback="No changes to show.">
                    Loading diff…
                  </Show>
                </div>
              }
            >
              {(f) => (
                <DiffRenderer
                  file={f()}
                  mode={state.diffMode}
                  hunkActions={hunkActions()}
                  repoPath={props.repoPath}
                  lineNumbers={state.diffLineNumbers}
                />
              )}
            </Show>
          </div>
        }>
        <Show
          when={sides()}
          fallback={
            <div class="h-full flex items-center justify-center text-muted-foreground text-body">
              <Show when={data.loading} fallback="Could not read this file.">
                Loading diff…
              </Show>
            </div>
          }
        >
          {(s) => (
            <Show
              when={!s().unavailable}
              fallback={
                <div class="h-full flex items-center justify-center text-muted-foreground text-body">
                  {s().unavailable}
                </div>
              }
            >
              <MonacoDiffPane
                original={s().original}
                modified={s().modified}
                path={props.filePath}
                sideBySide={state.diffMode === "split"}
                ignoreWhitespace={state.ignoreWhitespace}
              />
            </Show>
          )}
        </Show>
        </Show>
        </Show>
      </div>
    </div>
  );
}
