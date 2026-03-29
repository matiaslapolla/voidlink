import { createSignal, createResource, For, Show } from "solid-js";
import { Plus, Terminal, Trash2, Lock } from "lucide-solid";
import { gitApi } from "@/api/git";

interface WorktreePanelProps {
  repoPath: string;
  onOpenTerminal: (worktreePath: string) => void;
}

export function WorktreePanel(props: WorktreePanelProps) {
  const [creating, setCreating] = createSignal(false);
  const [newBranch, setNewBranch] = createSignal("");
  const [baseRef, setBaseRef] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);

  const [worktrees, { refetch }] = createResource(
    () => props.repoPath,
    (path) => gitApi.listWorktrees(path),
  );

  const handleCreate = async () => {
    const branch = newBranch().trim();
    if (!branch) return;
    setError(null);
    try {
      await gitApi.createWorktree({
        repoPath: props.repoPath,
        branchName: branch,
        baseRef: baseRef().trim() || undefined,
      });
      setCreating(false);
      setNewBranch("");
      setBaseRef("");
      refetch();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRemove = async (name: string) => {
    setRemoving(name);
    setError(null);
    try {
      await gitApi.removeWorktree(props.repoPath, name, false);
      refetch();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold">Worktrees</h3>
        <button
          onClick={() => setCreating((p) => !p)}
          class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-2 py-1 hover:bg-accent/60"
        >
          <Plus class="w-3.5 h-3.5" />
          New
        </button>
      </div>

      <Show when={creating()}>
        <div class="rounded-md border border-border p-3 space-y-2">
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Branch name</label>
            <input
              value={newBranch()}
              onInput={(e) => setNewBranch(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
              placeholder="feature/my-branch"
              class="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none"
              autofocus
            />
          </div>
          <div>
            <label class="block text-xs text-muted-foreground mb-1">
              Base ref (optional, defaults to HEAD)
            </label>
            <input
              value={baseRef()}
              onInput={(e) => setBaseRef(e.currentTarget.value)}
              placeholder="main"
              class="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none"
            />
          </div>
          <div class="flex gap-2">
            <button
              onClick={() => void handleCreate()}
              class="rounded bg-primary text-primary-foreground px-3 py-1 text-xs"
            >
              Create
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setNewBranch("");
                setBaseRef("");
              }}
              class="rounded border border-border px-3 py-1 text-xs hover:bg-accent/60"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <p class="text-xs text-destructive">{error()}</p>
      </Show>

      <Show when={worktrees.loading}>
        <p class="text-xs text-muted-foreground">Loading worktrees…</p>
      </Show>

      <Show when={(worktrees() ?? []).length === 0 && !worktrees.loading}>
        <p class="text-sm text-muted-foreground">No worktrees yet. Create one to isolate agent work.</p>
      </Show>

      <For each={worktrees() ?? []}>
        {(wt) => (
          <div class="rounded-md border border-border p-3 space-y-2">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="font-medium text-sm truncate">{wt.name}</span>
                  <Show when={wt.isLocked}>
                    <Lock class="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  </Show>
                </div>
                <div class="text-xs text-muted-foreground truncate">{wt.path}</div>
              </div>
              <div class="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => props.onOpenTerminal(wt.path)}
                  title="Open terminal in worktree"
                  class="p-1 rounded hover:bg-accent/60 transition-colors"
                >
                  <Terminal class="w-3.5 h-3.5 text-muted-foreground" />
                </button>
                <button
                  onClick={() => void handleRemove(wt.name)}
                  disabled={removing() === wt.name || wt.isLocked}
                  title="Remove worktree"
                  class="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-40"
                >
                  <Trash2 class="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </div>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
