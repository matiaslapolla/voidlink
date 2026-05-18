import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { File, Search } from "lucide-solid";
import { gitApi } from "@/api/git";
import { closeFileFinder, isFileFinderOpen } from "@/commands/registry";

function fuzzyScore(path: string, query: string): number {
  if (!query) return 0;
  const t = path.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) {
    // Heavily prefer matches on the file name (last segment).
    const slash = t.lastIndexOf("/");
    if (idx > slash) return 2000 - (idx - slash);
    return 1000 - idx;
  }
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score -= found - ti;
    ti = found + 1;
  }
  return 100 + score;
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
  const [highlight, setHighlight] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  // Cache the file list per repo path — re-runs when path changes.
  const [files] = createResource(
    () => props.repoPath,
    (p) => gitApi.lsFiles(p),
  );

  onMount(() => queueMicrotask(() => inputRef?.focus()));

  const ranked = createMemo<Array<{ path: string; score: number }>>(() => {
    const list = files() ?? [];
    const q = query();
    if (!q.trim()) {
      return list.slice(0, 200).map((p) => ({ path: p, score: 0 }));
    }
    return list
      .map((p) => ({ path: p, score: fuzzyScore(p, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);
  });

  function open(index: number) {
    const r = ranked()[index];
    if (!r) return;
    closeFileFinder();
    props.onOpenFile(`${props.repoPath}/${r.path}`);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = ranked();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(list.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(highlight());
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFileFinder();
    }
  }

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[80] flex items-start justify-center pt-[12vh] bg-black/40"
        onClick={closeFileFinder}
      >
        <div
          class="w-[560px] max-w-[92vw] bg-popover border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Open tracked file…"
              class="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
            />
            <span class="text-[10px] text-muted-foreground/70 tracking-wide">ESC</span>
          </div>
          <div class="max-h-[60vh] overflow-y-auto scrollbar-thin py-1">
            <Show when={files.loading}>
              <div class="px-3 py-6 text-center text-xs text-muted-foreground">
                Indexing tracked files…
              </div>
            </Show>
            <Show when={!files.loading && ranked().length === 0}>
              <div class="px-3 py-6 text-center text-xs text-muted-foreground">
                No matching files
              </div>
            </Show>
            <For each={ranked()}>
              {(row, i) => (
                <FinderRow
                  path={row.path}
                  highlighted={highlight() === i()}
                  onClick={() => open(i())}
                  onMouseEnter={() => setHighlight(i())}
                />
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function FinderRow(props: {
  path: string;
  highlighted: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const name = () => props.path.split("/").pop() ?? props.path;
  const dir = () => {
    const idx = props.path.lastIndexOf("/");
    return idx === -1 ? "" : props.path.slice(0, idx);
  };
  return (
    <button
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
      class={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
        props.highlighted ? "bg-accent/70 text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      }`}
    >
      <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <span class="truncate font-medium">{name()}</span>
      <Show when={dir()}>
        {(d) => (
          <span class="ml-2 text-[11px] text-muted-foreground/70 truncate">{d()}</span>
        )}
      </Show>
    </button>
  );
}
