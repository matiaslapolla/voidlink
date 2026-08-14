/// The palette — one overlay, two modes, reached by ⌘P or ⌘K.
///
/// ⌘P used to open a file finder and ⌘K a command list, which made "open a
/// thing" two chords with a rule about which one held what: a terminal tab, a
/// board, an agent and a browser tab were all behind ⌘K, and files were behind
/// ⌘P, and nothing on screen said so. Now both chords open this, and the query
/// decides: bare text searches files, open tabs and recently closed files, a
/// leading `>` searches commands. ⌘K is the same overlay with the `>` already
/// typed, so the two entry points are one keystroke apart rather than two
/// surfaces apart. `paletteMode.ts` owns that parsing.
///
/// Three things carry over from the ⌘K palette this grew out of:
///
///   1. **Recently-used first.** Actions the user ran this session float to the
///      top of the resting command list. The order is snapshotted when the
///      palette opens and held for as long as it is on screen — reordering rows
///      under a user who is halfway through a muscle-memory press is worse than
///      not ranking at all.
///   2. **Match ranges, not just scores.** `fuzzy.ts` returns which characters
///      matched and `FuzzyText` tints them, using the same treatment as the
///      switchers.
///   3. **Nothing animates.** Both chords are keyboard-initiated (MASTER §7.1).
///
/// The file list stays lazy. `gitApi.lsFiles` walks a repo, and a palette opened
/// straight into command mode has no use for the answer — so the resource's
/// source is falsy until file mode is actually entered, and latched true after
/// that so typing and deleting a `>` does not re-walk the repo each time.
import { Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { FileClock, SearchX } from "lucide-solid";
import { gitApi } from "@/api/git";
import {
  type Action,
  closePalette,
  getVisibleActions,
  isPaletteOpen,
  paletteSeedQuery,
  recentActionOrder,
  runAction,
} from "@/commands/registry";
import { COMMAND_PREFIX, paletteMode, paletteTerm } from "@/commands/paletteMode";
import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import {
  FileRow,
  IgnoredFilesToggle,
  isToggleIgnoredChord,
  rankFiles,
} from "@/commands/FileFinder";
import { TabKindIcon } from "@/commands/TabCycleOverlay";
import { shortcutLabel } from "@/commands/shortcuts";
import type { OpenTabTarget, RecentFileTarget } from "@/commands/targets";
import { useSettings } from "@/store/settings";

export interface CommandPaletteProps {
  /// Open tabs to mix into file mode. Omitted in windows that have none.
  openTabs?: () => OpenTabTarget[];
  recentFiles?: () => RecentFileTarget[];
  /// The repo whose tracked files file mode lists. `null` in a workspace
  /// pointed at a plain folder — the mode still works, it just has open tabs
  /// and recent files in it and nothing to walk.
  repoPath: string | null;
  onOpenFile: (absolutePath: string) => void;
}

type Row =
  | { sort: "action"; key: string; action: Action; score: number; ranges: MatchRange[] }
  | { sort: "tab"; key: string; tab: OpenTabTarget; score: number; ranges: MatchRange[] }
  | { sort: "recent"; key: string; file: RecentFileTarget; score: number; ranges: MatchRange[] }
  | { sort: "file"; key: string; path: string; score: number; ranges: MatchRange[] };

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Show when={isPaletteOpen()}>
      <PaletteContent
        openTabs={props.openTabs}
        recentFiles={props.recentFiles}
        repoPath={props.repoPath}
        onOpenFile={props.onOpenFile}
      />
    </Show>
  );
}

function PaletteContent(props: CommandPaletteProps) {
  /// Seeded by whoever opened the palette: empty for ⌘P, `>` for ⌘K. Read once
  /// — this component mounts fresh on every open.
  const [query, setQuery] = createSignal(paletteSeedQuery());

  const mode = () => paletteMode(query());
  const term = () => paletteTerm(query());

  /// Captured once, on mount. See the module comment — this is the "stable
  /// within a session" requirement, and it is why this is a plain array rather
  /// than a call to `recentActionOrder()` inside the memo.
  const recency = new Map(recentActionOrder().map((id, i) => [id, i]));

  const { settings, updateUi } = useSettings();
  const showIgnored = () => settings.ui.showIgnoredFiles;
  const toggleIgnored = () => updateUi({ showIgnoredFiles: !showIgnored() });

  /// Latched rather than derived from `mode()`. A falsy resource source is what
  /// keeps command mode from walking the repo, but going falsy *again* would
  /// drop the cached list — so once file mode has been asked for, the source
  /// stays live and the list is fetched exactly once per repo/ignored pair.
  const [wantsFiles, setWantsFiles] = createSignal(mode() === "files");
  createEffect(() => {
    if (mode() === "files") setWantsFiles(true);
  });

  const [files] = createResource(
    () =>
      wantsFiles() && props.repoPath
        ? { path: props.repoPath, includeIgnored: showIgnored() }
        : false,
    (src) => gitApi.lsFiles(src.path, src.includeIgnored),
  );

  /// Commands, recency-ordered at rest. With a query, score decides and recency
  /// only breaks ties — otherwise a stale favourite would outrank an exact
  /// match.
  const commandRows = createMemo<Row[]>(() => {
    const q = term();
    const out: Row[] = [];
    for (const action of getVisibleActions()) {
      const match = bestFuzzyMatch([action.label, action.group ?? ""], q);
      if (!match) continue;
      out.push({
        sort: "action",
        key: `a:${action.id}`,
        action,
        // Only a label match is worth highlighting; a hit on the group column
        // would tint text the user did not type against.
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }
    const rank = (row: Row) =>
      row.sort === "action"
        ? (recency.get(row.action.id) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
    if (!q) return out.sort((a, b) => rank(a) - rank(b));
    return out.sort((a, b) => b.score - a.score || rank(a) - rank(b));
  });

  /// Files, and the two things that behave like files: what is already open and
  /// what was recently closed. Both were in ⌘K's default list before the merge
  /// and belong here for the same reason ⌘P exists at all — "get me to that
  /// file" rarely cares whether it happens to be open already.
  const fileRows = createMemo<Row[]>(() => {
    const q = term();
    const out: Row[] = [];

    for (const tab of props.openTabs?.() ?? []) {
      const match = bestFuzzyMatch([tab.label, tab.detail ?? ""], q);
      if (!match) continue;
      out.push({
        sort: "tab",
        key: `t:${tab.id}`,
        tab,
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }
    for (const file of props.recentFiles?.() ?? []) {
      const match = bestFuzzyMatch([file.label, file.path], q, { pathAware: true });
      if (!match) continue;
      out.push({
        sort: "recent",
        key: `f:${file.path}`,
        file,
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }
    // Ranked and capped on its own before joining the list: this is the one
    // source that can be tens of thousands of rows long.
    for (const ranked of rankFiles(files() ?? [], q)) {
      out.push({
        sort: "file",
        key: `p:${ranked.path}`,
        path: ranked.path,
        ranges: ranked.ranges,
        score: ranked.score,
      });
    }

    if (!q) {
      // Resting order: open tabs (the thing you are most likely to want back),
      // then recently closed files, then the repo.
      const bucket = (row: Row) => (row.sort === "tab" ? 0 : row.sort === "recent" ? 1 : 2);
      return out.sort((a, b) => bucket(a) - bucket(b));
    }
    return out.sort((a, b) => b.score - a.score);
  });

  const rows = () => (mode() === "commands" ? commandRows() : fileRows());

  function pick(row: Row) {
    if (row.sort === "action") {
      if (row.action.enabled && !row.action.enabled()) return;
      closePalette();
      void runAction(row.action);
      return;
    }
    closePalette();
    if (row.sort === "tab") row.tab.open();
    else if (row.sort === "recent") row.file.open();
    else props.onOpenFile(`${props.repoPath}/${row.path}`);
  }

  return (
    <QuickPick
      items={rows()}
      itemKey={(row) => row.key}
      query={query()}
      onQuery={setQuery}
      onPick={pick}
      onClose={closePalette}
      label="Command palette"
      width="w-[560px]"
      placeholder={
        mode() === "commands"
          ? "Run a command…"
          : `Open a file, tab or recent file… (${COMMAND_PREFIX} for commands)`
      }
      loading={mode() === "files" && files.loading}
      loadingLabel={showIgnored() ? "Indexing files…" : "Indexing tracked files…"}
      onKeyDown={(e) => {
        // The finder's ⌥H, kept where it is useful and inert where it is not.
        if (mode() === "files" && isToggleIgnoredChord(e)) {
          e.preventDefault();
          toggleIgnored();
          return true;
        }
        return false;
      }}
      headerTrailing={
        <Show when={mode() === "files" && !!props.repoPath}>
          <IgnoredFilesToggle showIgnored={showIgnored()} onToggle={toggleIgnored} />
        </Show>
      }
      empty={
        <QuickPickEmpty
          icon={<SearchX class="w-5 h-5" />}
          message="Nothing matches that."
          hint={
            mode() === "commands"
              ? `Drop the ${COMMAND_PREFIX} to search files, open tabs and recent files.`
              : showIgnored()
                ? `Type ${COMMAND_PREFIX} to search commands instead.`
                : `⌥H also searches gitignored files; ${COMMAND_PREFIX} searches commands.`
          }
        />
      }
      renderItem={(row, highlighted) => <PaletteRow row={row} highlighted={highlighted()} />}
    />
  );
}

function PaletteRow(props: { row: Row; highlighted: boolean }) {
  const disabled = () =>
    props.row.sort === "action" && !!props.row.action.enabled && !props.row.action.enabled();

  return (
    <Show
      when={props.row.sort === "file" ? props.row : undefined}
      fallback={
        <QuickPickRow
          highlighted={props.highlighted}
          disabled={disabled()}
          disabledReason="Not available in this context — open a repository first"
        >
          <Show when={props.row.sort === "action" ? props.row : undefined}>
            {(row) => (
              <>
                <span class="text-micro tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
                  {row().action.group ?? ""}
                </span>
                <span class="flex-1 truncate">
                  <FuzzyText text={row().action.label} ranges={row().ranges} />
                  <Show when={row().action.description}>
                    {(d) => <span class="ml-2 text-label text-muted-foreground/80">· {d()}</span>}
                  </Show>
                </span>
                <Accelerator actionId={row().action.id} />
              </>
            )}
          </Show>

          <Show when={props.row.sort === "tab" ? props.row : undefined}>
            {(row) => (
              <>
                <span class="text-micro tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
                  open
                </span>
                <TabKindIcon kind={row().tab.kind} />
                <span class="flex-1 truncate">
                  <FuzzyText text={row().tab.label} ranges={row().ranges} />
                  <Show when={row().tab.detail}>
                    {(d) => <span class="ml-2 text-label text-muted-foreground/80">· {d()}</span>}
                  </Show>
                </span>
              </>
            )}
          </Show>

          <Show when={props.row.sort === "recent" ? props.row : undefined}>
            {(row) => (
              <>
                <span class="text-micro tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
                  recent
                </span>
                <FileClock class="w-3.5 h-3.5 shrink-0 opacity-60" />
                <span class="flex-1 truncate">
                  <FuzzyText text={row().file.label} ranges={row().ranges} />
                  <span class="ml-2 text-label text-muted-foreground/80 font-mono">
                    {row().file.path}
                  </span>
                </span>
              </>
            )}
          </Show>
        </QuickPickRow>
      }
    >
      {/* The repo-file row is `FileFinder.tsx`'s own — the name/directory split
          and the rebased match ranges are what the standalone finder drew, and
          it draws its own `QuickPickRow`. */}
      {(row) => (
        <FileRow
          path={row().path}
          ranges={row().ranges}
          highlighted={props.highlighted}
          kindLabel="file"
        />
      )}
    </Show>
  );
}

/// Derived from the keymap, never stored on the action — the label and the
/// chord that actually fires cannot disagree.
function Accelerator(props: { actionId: string }) {
  const label = () => shortcutLabel(props.actionId);
  return (
    <Show when={label()}>
      {(s) => (
        <span class="ml-auto shrink-0 text-right text-micro text-muted-foreground font-mono tracking-wide">
          {s()}
        </span>
      )}
    </Show>
  );
}
