/// The snapshot manager: save, restore, rename and delete a worktree's saved
/// sessions in one place.
///
/// Snapshots existed before this surface, but only as command-palette entries —
/// one `snapshot.restore.<name>` and one `snapshot.delete.<name>` per saved
/// snapshot, which meant the palette grew two rows per snapshot and there was
/// nowhere to see what a snapshot actually held, and no way to rename one at
/// all.
///
/// Motion budget (MASTER §7.1): this surface is reachable from the keyboard
/// and every operation in it is keyboard-initiated, so nothing here animates —
/// no dialog enter, no list transition, no selection slide. The only moving
/// pixels are the `animate-spin` on a restore that is genuinely in flight,
/// which is a functional loop (§7.3.9) and stops when the work does.
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Archive, Check, Loader2, Pencil, Trash2, X } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import { textPrompt } from "@/commands/prompt";
import {
  removeSnapshot,
  renameSnapshot,
  snapshotTabCount,
  snapshotsFor,
  type WorkspaceSnapshot,
} from "@/commands/snapshots";

interface SnapshotManagerProps {
  open: boolean;
  onClose: () => void;
}

/// "3m", "2h", "5d" — a saved-at stamp is a rough recency cue, not a date.
function ago(ts: number): string {
  if (!ts) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/// One line naming what is inside, so a restore is never a guess.
function contents(snap: WorkspaceSnapshot): string {
  const t = snap.tabs;
  const parts: string[] = [];
  const add = (n: number, one: string, many = `${one}s`) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(t.files.length, "file");
  add(t.terminals.length, "terminal");
  add(t.diffs.length, "diff");
  add(t.compares.length, "compare");
  add(t.stacks.length, "stack");
  add(t.conflicts.length, "conflict");
  add(t.previews.length, "preview");
  add(t.browsers.length, "browser tab");
  if (t.history) parts.push("commit graph");
  if (t.brain) parts.push("brain");
  if (parts.length === 0) return "no tabs";
  return parts.join(" · ");
}

export function SnapshotManager(props: SnapshotManagerProps) {
  const { state, actions } = useAppStore();
  const [selected, setSelected] = createSignal(0);
  const [restoring, setRestoring] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [renameError, setRenameError] = createSignal<string | null>(null);
  let dialogRef: HTMLDivElement | undefined;
  let listRef: HTMLDivElement | undefined;

  const wtId = () => state.activeWorktreeId;
  const list = createMemo(() => snapshotsFor(wtId()));

  createEffect(() => {
    if (!props.open) return;
    setSelected(0);
    setConfirmDelete(null);
    setRenaming(null);
    queueMicrotask(() => listRef?.focus());
  });

  const trapFocus = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = [
      ...(dialogRef?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  async function saveNew() {
    const name = await textPrompt({
      title: "Save snapshot",
      label: "Name this snapshot of tabs, terminals, panes and sidebar state",
      placeholder: "before-refactor",
      confirmLabel: "Save",
    });
    if (!name) return;
    actions.saveWorkspaceSnapshot(wtId(), name);
    pushToast(`Snapshot "${name}" saved`, "success");
  }

  async function restore(snap: WorkspaceSnapshot) {
    setRestoring(snap.name);
    try {
      const ok = await actions.restoreWorkspaceSnapshot(wtId(), snap.name);
      if (ok) {
        pushToast(`Restored "${snap.name}"`, "success");
        props.onClose();
      } else {
        pushToast(`Snapshot "${snap.name}" not found`, "error");
      }
    } finally {
      setRestoring(null);
    }
  }

  function del(snap: WorkspaceSnapshot) {
    // Two-step rather than a modal-on-a-modal: deleting a snapshot destroys a
    // named thing the user made, so it confirms (§10.7), but it does not
    // deserve a second dialog.
    if (confirmDelete() !== snap.name) {
      setConfirmDelete(snap.name);
      return;
    }
    removeSnapshot(wtId(), snap.name);
    setConfirmDelete(null);
    pushToast(`Deleted "${snap.name}"`, "info");
  }

  function beginRename(snap: WorkspaceSnapshot) {
    setRenameDraft(snap.name);
    setRenameError(null);
    setRenaming(snap.name);
  }

  function commitRename(snap: WorkspaceSnapshot) {
    const result = renameSnapshot(wtId(), snap.name, renameDraft());
    if (result === "ok") {
      setRenaming(null);
      setRenameError(null);
      return;
    }
    setRenameError(
      result === "empty-name"
        ? "A snapshot needs a name"
        : result === "duplicate"
          ? "That name is already taken"
          : "That snapshot is gone",
    );
  }

  const onListKeyDown = (e: KeyboardEvent) => {
    const items = list();
    if (renaming()) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setSelected(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSelected(Math.max(0, items.length - 1));
    } else if (e.key === "Enter") {
      const snap = items[selected()];
      if (snap) {
        e.preventDefault();
        void restore(snap);
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const snap = items[selected()];
      if (snap) {
        e.preventDefault();
        del(snap);
      }
    } else if (e.key === "F2") {
      const snap = items[selected()];
      if (snap) {
        e.preventDefault();
        beginRename(snap);
      }
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
        onClick={props.onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="snapshot-manager-title"
          class="w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={trapFocus}
        >
          <div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <h2 id="snapshot-manager-title" class="text-sm font-semibold">
              Snapshots
            </h2>
            <button
              onClick={props.onClose}
              aria-label="Close snapshot manager"
              title="Close"
              class="p-1 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring transition-colors"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <div
            ref={listRef}
            tabIndex={0}
            role="listbox"
            aria-label="Saved snapshots"
            aria-activedescendant={
              list()[selected()] ? `snapshot-row-${selected()}` : undefined
            }
            onKeyDown={onListKeyDown}
            class="flex-1 overflow-y-auto scrollbar-thin p-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset outline-none"
          >
            <Show
              when={list().length > 0}
              fallback={
                // §9.7 — and deliberately sharing neither its icon (Archive)
                // nor its sentence with any other empty state in the app.
                <div class="flex flex-col items-center gap-2 py-10 text-center">
                  <Archive class="w-5 h-5 text-muted-foreground opacity-60" />
                  <p class="text-xs text-muted-foreground">
                    Nothing has been snapshotted in this worktree yet.
                  </p>
                  <button
                    onClick={() => void saveNew()}
                    class="px-3 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  >
                    Save this session as a snapshot
                  </button>
                </div>
              }
            >
              <For each={list()}>
                {(snap, i) => (
                  <div
                    id={`snapshot-row-${i()}`}
                    role="option"
                    aria-selected={selected() === i()}
                    onClick={() => setSelected(i())}
                    class={`flex items-center gap-2 rounded px-2 py-1.5 ${
                      selected() === i() ? "bg-accent/60" : "hover:bg-accent/30"
                    }`}
                  >
                    <div class="flex-1 min-w-0">
                      <Show
                        when={renaming() === snap.name}
                        fallback={
                          <>
                            <div class="text-xs truncate">{snap.name}</div>
                            <div class="text-[10px] text-muted-foreground truncate">
                              {contents(snap)} · {snapshotTabCount(snap)} tabs ·{" "}
                              {ago(snap.savedAt)}
                            </div>
                          </>
                        }
                      >
                        <label class="sr-only" for={`snapshot-rename-${i()}`}>
                          Snapshot name
                        </label>
                        <input
                          id={`snapshot-rename-${i()}`}
                          value={renameDraft()}
                          autofocus
                          aria-invalid={renameError() !== null}
                          onInput={(e) => {
                            setRenameDraft(e.currentTarget.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") commitRename(snap);
                            if (e.key === "Escape") {
                              setRenaming(null);
                              setRenameError(null);
                            }
                          }}
                          class={`w-full rounded border bg-muted/40 px-2 py-1 text-xs outline-2 outline-transparent focus:outline-none focus:ring-1 focus:ring-ring ${
                            renameError() ? "border-destructive" : "border-border"
                          }`}
                        />
                        <Show when={renameError()}>
                          <div class="text-[10px] text-destructive mt-0.5">
                            {renameError()}
                          </div>
                        </Show>
                      </Show>
                    </div>

                    <Show
                      when={renaming() !== snap.name}
                      fallback={
                        <button
                          onClick={() => commitRename(snap)}
                          aria-label={`Save the new name for ${snap.name}`}
                          title="Save name (Enter)"
                          class="p-1 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                        >
                          <Check class="w-3.5 h-3.5" />
                        </button>
                      }
                    >
                      <button
                        onClick={() => void restore(snap)}
                        // Pending is not disabled (§7.6 / §10.11): the control
                        // keeps its label, its focus and its place in the tab
                        // order while the PTYs come up.
                        aria-label={`Restore snapshot ${snap.name}`}
                        title="Restore (Enter)"
                        class="px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring transition-colors flex items-center gap-1"
                      >
                        <Show when={restoring() === snap.name}>
                          <Loader2 class="w-3 h-3 animate-spin" />
                        </Show>
                        Restore
                      </button>
                      <button
                        onClick={() => beginRename(snap)}
                        aria-label={`Rename snapshot ${snap.name}`}
                        title="Rename (F2)"
                        class="p-1 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                      >
                        <Pencil class="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => del(snap)}
                        aria-label={
                          confirmDelete() === snap.name
                            ? `Confirm deleting snapshot ${snap.name}`
                            : `Delete snapshot ${snap.name}`
                        }
                        title={
                          confirmDelete() === snap.name
                            ? "Click again to delete"
                            : "Delete (Del)"
                        }
                        class={`p-1 rounded focus-visible:ring-2 focus-visible:ring-ring transition-colors ${
                          confirmDelete() === snap.name
                            ? "text-destructive bg-destructive/10"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        }`}
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="flex items-center justify-between px-4 py-2.5 border-t border-border">
            <span class="text-[10px] text-muted-foreground">
              ↑↓ select · Enter restore · F2 rename · Del delete
            </span>
            <button
              onClick={() => void saveNew()}
              class="px-3 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring transition-colors"
            >
              Save current session…
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
