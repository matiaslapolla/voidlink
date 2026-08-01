import { Show, createMemo, createResource, createSignal } from "solid-js";
import { Eye, EyeOff, File, FileSearch } from "lucide-solid";
import { gitApi } from "@/api/git";
import { closeFileFinder, isFileFinderOpen } from "@/commands/registry";
import { fuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import { useSettings } from "@/store/settings";

interface Ranked {
  path: string;
  score: number;
  ranges: MatchRange[];
}

export function FileFinder(props: {
  repoPath: string | null;
  onOpenFile: (absolutePath: string) => void;
}) {
  return (
    <Show when={isFileFinderOpen() && props.repoPath}>
      <FinderContent repoPath={props.repoPath!} onOpenFile={props.onOpenFile} />
    </Show>
  );
}

function FinderContent(props: {
  repoPath: string;
  onOpenFile: (absolutePath: string) => void;
}) {
  const [query, setQuery] = createSignal("");

  const { settings, updateUi } = useSettings();
  const showIgnored = () => settings.ui.showIgnoredFiles;
  const toggleIgnored = () => updateUi({ showIgnoredFiles: !showIgnored() });

  // Cache the file list per repo path — re-runs when the path or the
  // ignored-files preference changes.
  const [files] = createResource(
    () => ({ path: props.repoPath, includeIgnored: showIgnored() }),
    (src) => gitApi.lsFiles(src.path, src.includeIgnored),
  );

  const ranked = createMemo<Ranked[]>(() => {
    const list = files() ?? [];
    const q = query().trim();
    if (!q) return list.slice(0, 200).map((path) => ({ path, score: 0, ranges: [] }));
    const out: Ranked[] = [];
    for (const path of list) {
      // `pathAware`: a hit in the file's own name beats the same letters buried
      // in a directory, which is what makes typing a basename work.
      const match = fuzzyMatch(path, q, { pathAware: true });
      if (match) out.push({ path, score: match.score, ranges: match.ranges });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 200);
  });

  function open(row: Ranked) {
    closeFileFinder();
    props.onOpenFile(`${props.repoPath}/${row.path}`);
  }

  return (
    <QuickPick
      items={ranked()}
      itemKey={(r) => r.path}
      query={query()}
      onQuery={setQuery}
      onPick={open}
      onClose={closeFileFinder}
      label="Open file"
      placeholder={showIgnored() ? "Open any file, ignored included…" : "Open tracked file…"}
      loading={files.loading}
      loadingLabel={showIgnored() ? "Indexing files…" : "Indexing tracked files…"}
      onKeyDown={(e) => {
        // Alt+H mirrors the header button. macOS turns Alt+H into "˙", so both
        // the letter and the dead-key output are accepted.
        if (e.altKey && (e.key === "h" || e.key === "˙")) {
          e.preventDefault();
          toggleIgnored();
          return true;
        }
        return false;
      }}
      headerTrailing={
        <button
          type="button"
          onClick={toggleIgnored}
          aria-label={showIgnored() ? "Hide gitignored files" : "Show gitignored files"}
          aria-pressed={showIgnored()}
          title={
            showIgnored()
              ? "Hide gitignored files (⌥H)"
              : "Show gitignored files, e.g. .env (⌥H)"
          }
          class={`shrink-0 p-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            showIgnored()
              ? "text-foreground bg-accent/60"
              : "text-muted-foreground/70 hover:text-foreground hover:bg-accent/40"
          }`}
        >
          {showIgnored() ? <Eye class="w-3.5 h-3.5" /> : <EyeOff class="w-3.5 h-3.5" />}
        </button>
      }
      empty={
        <QuickPickEmpty
          icon={<FileSearch class="w-5 h-5" />}
          message="No tracked file matches that."
          hint={showIgnored() ? undefined : "⌥H also searches gitignored files."}
        />
      }
      renderItem={(row, highlighted) => (
        <FinderRow path={row.path} ranges={row.ranges} highlighted={highlighted()} />
      )}
    />
  );
}

function FinderRow(props: { path: string; ranges: MatchRange[]; highlighted: boolean }) {
  const cut = () => props.path.lastIndexOf("/");
  const name = () => (cut() === -1 ? props.path : props.path.slice(cut() + 1));
  const dir = () => (cut() === -1 ? "" : props.path.slice(0, cut()));
  /// The matcher ran against the whole path, so the ranges are rebased onto the
  /// two halves the row draws rather than re-matching each of them.
  const shift = (from: number, to: number): MatchRange[] =>
    props.ranges
      .map(([s, e]): MatchRange => [Math.max(s, from) - from, Math.min(e, to) - from])
      .filter(([s, e]) => e > s);

  return (
    <QuickPickRow highlighted={props.highlighted}>
      <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <FuzzyText
        text={name()}
        ranges={shift(cut() + 1, props.path.length)}
        class="truncate font-medium"
      />
      <Show when={dir()}>
        <FuzzyText
          text={dir()}
          ranges={shift(0, cut())}
          class="ml-2 text-label text-muted-foreground/70 truncate"
        />
      </Show>
    </QuickPickRow>
  );
}
