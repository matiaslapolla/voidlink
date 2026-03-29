import {
  createSignal,
  createResource,
  For,
  Show,
  onMount,
  onCleanup,
} from "solid-js";
import { GitBranch, Plus, ArrowUp, ArrowDown } from "lucide-solid";
import { gitApi } from "@/api/git";

interface BranchPickerProps {
  repoPath: string;
  onClose: () => void;
  onBranchCheckedOut: () => void;
}

export function BranchPicker(props: BranchPickerProps) {
  const [filter, setFilter] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [newBranchName, setNewBranchName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  let ref: HTMLDivElement | undefined;
  let filterInput: HTMLInputElement | undefined;

  const [branches] = createResource(
    () => props.repoPath,
    (path) => gitApi.listBranches(path, false),
  );

  onMount(() => {
    filterInput?.focus();
    const handler = (e: MouseEvent) => {
      if (ref && !ref.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  const filtered = () => {
    const q = filter().toLowerCase();
    return (branches() ?? []).filter((b) =>
      b.name.toLowerCase().includes(q),
    );
  };

  const checkout = async (name: string, create = false) => {
    setError(null);
    try {
      await gitApi.checkoutBranch(props.repoPath, name, create);
      props.onBranchCheckedOut();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreate = async () => {
    const name = newBranchName().trim();
    if (!name) return;
    await checkout(name, true);
    setCreating(false);
    setNewBranchName("");
  };

  return (
    <div
      ref={ref}
      class="absolute bottom-full left-0 mb-1 z-50 w-72 bg-popover border border-border rounded-lg shadow-xl overflow-hidden"
    >
      <div class="p-2 border-b border-border">
        <input
          ref={filterInput}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter branches..."
          class="w-full rounded bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div class="max-h-64 overflow-y-auto py-1">
        <Show when={(branches.loading)}>
          <div class="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        </Show>

        <For each={filtered()}>
          {(branch) => (
            <button
              onClick={() => checkout(branch.name)}
              class={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors text-left ${
                branch.isHead ? "text-primary font-medium" : "text-foreground"
              }`}
            >
              <GitBranch class="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
              <span class="flex-1 truncate">{branch.name}</span>
              <Show when={branch.ahead > 0 || branch.behind > 0}>
                <span class="flex items-center gap-1 text-muted-foreground">
                  <Show when={branch.ahead > 0}>
                    <span class="flex items-center gap-0.5">
                      <ArrowUp class="w-3 h-3" />
                      {branch.ahead}
                    </span>
                  </Show>
                  <Show when={branch.behind > 0}>
                    <span class="flex items-center gap-0.5">
                      <ArrowDown class="w-3 h-3" />
                      {branch.behind}
                    </span>
                  </Show>
                </span>
              </Show>
            </button>
          )}
        </For>

        <Show when={(branches() ?? []).length === 0 && !branches.loading}>
          <div class="px-3 py-2 text-xs text-muted-foreground">No branches found</div>
        </Show>
      </div>

      <div class="border-t border-border p-2">
        <Show
          when={creating()}
          fallback={
            <button
              onClick={() => {
                setCreating(true);
                setFilter("");
              }}
              class="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <Plus class="w-3.5 h-3.5" />
              New branch
            </button>
          }
        >
          <div class="flex gap-1">
            <input
              value={newBranchName()}
              onInput={(e) => setNewBranchName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewBranchName("");
                }
              }}
              placeholder="branch-name"
              class="flex-1 rounded bg-background px-2 py-1 text-xs outline-none"
              autofocus
            />
            <button
              onClick={() => void handleCreate()}
              class="rounded bg-primary text-primary-foreground px-2 py-1 text-xs"
            >
              Create
            </button>
          </div>
        </Show>

        <Show when={error()}>
          <p class="mt-1 text-xs text-destructive">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
