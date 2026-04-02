import { Show, For } from "solid-js";
import { Search } from "lucide-solid";
import type { SearchResult } from "@/types/migration";

interface SearchTabProps {
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;
  repoRoot: string | null;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onAddContext: (result: SearchResult) => void;
}

export function SearchTab(props: SearchTabProps) {
  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      <div class="flex gap-2">
        <input
          value={props.searchQuery}
          onInput={(event) => props.onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSearch();
            }
          }}
          placeholder="Search files and snippets..."
          class="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
        />
        <button
          onClick={props.onSearch}
          disabled={!props.repoRoot || props.searching || props.searchQuery.trim().length === 0}
          class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
        >
          <Search class="inline w-4 h-4 mr-1" />
          {props.searching ? "Searching..." : "Search"}
        </button>
      </div>

      <Show when={props.searchResults.length > 0} fallback={<p class="text-sm text-muted-foreground">No results yet.</p>}>
        <div class="space-y-2">
          <For each={props.searchResults}>
            {(result) => (
              <article class="rounded-md border border-border bg-card/60 p-3 space-y-2">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="font-medium text-sm">{result.filePath}</div>
                    <div class="text-xs text-muted-foreground">{result.anchor}</div>
                  </div>
                  <button
                    onClick={() => props.onAddContext(result)}
                    class="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
                  >
                    Add to Context
                  </button>
                </div>
                <pre class="text-xs whitespace-pre-wrap text-muted-foreground bg-background/40 rounded p-2 overflow-auto">
                  {result.snippet}
                </pre>
                <div class="text-xs text-muted-foreground">
                  lexical {result.lexicalScore.toFixed(2)} | semantic {result.semanticScore.toFixed(2)} | graph {(result.why.graphProximity ?? 0).toFixed(2)}
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
