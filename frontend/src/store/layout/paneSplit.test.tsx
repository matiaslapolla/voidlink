/// Splitting a pane and landing a tab in it, driven through the **real store**.
///
/// `panes.test.ts` proves the reducer in isolation. This file exists because
/// the bug that made splitting look broken was not in the reducer: it was in
/// how the store *sequenced* it. A store write flushes effects, so a split that
/// was two writes — make an empty group, then move a tab into it — gave the
/// prune effect a look at a pane with nothing in it, and the prune collapsed
/// it. The move that followed addressed a group that no longer existed and did
/// nothing at all. Every piece passed its own test; the sequence was what
/// failed, and only a store with its effects running can show that.
///
/// The user-visible symptom was a drag onto a pane edge that showed its
/// preview, released, and changed nothing — sometimes.
///
/// **`.tsx` although it mounts nothing.** The extension is what picks the
/// project, and the `unit` project runs under `environment: "node"` with
/// Solid's *server* build: `createEffect` never runs there and a `createMemo`
/// is computed once and never recomputed. A store's reducers are testable in
/// that runtime — `panes.test.ts` is — but its reactivity is not, and the
/// reactivity is the entire subject here. The `render` project loads the client
/// runtime, so this is the only place the sequence can be observed at all.
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createAppStore } from "./index";
import { groupList, resolveGroupTabs } from "./panes";

async function withStore(
  fn: (store: ReturnType<typeof createAppStore>, wtId: string) => Promise<void> | void,
) {
  let done: Promise<void> | void = undefined;
  let dispose = () => {};
  createRoot((d) => {
    dispose = d;
    const store = createAppStore({ persist: false });
    done = fn(store, store.state.activeWorktreeId);
  });
  try {
    await done;
  } finally {
    dispose();
  }
}

/// Let Solid flush its effect queue.
///
/// The store's pruning is a `createEffect`, and effects are queued rather than
/// run inline: inside one synchronous block nothing it does is observable yet.
/// A test that asserted without this would be asserting on a store whose
/// effects had never run once — which is exactly how it would fail to notice
/// the prune eating a pane.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/// Effects run when the reactive system flushes, which for a write made outside
/// a computation is immediately after that write. Reading the layout back
/// through the store's own memo is what makes this test see what the workbench
/// sees rather than what the reducer returned.
function panes(store: ReturnType<typeof createAppStore>) {
  return groupList(store.paneLayout());
}

describe("splitting a pane by dropping a tab on its edge", () => {
  for (const placement of ["after", "before"] as const) {
    for (const orientation of ["row", "column"] as const) {
      it(`survives the prune and carries the tab — ${orientation}/${placement}`, async () => {
        await withStore(async (store, wtId) => {
          const { actions } = store;
          actions.openCompareTab(wtId, { baseRef: "main", headRef: "a" });
          actions.openCompareTab(wtId, { baseRef: "main", headRef: "b" });
          const tabs = store.workbenchTabIds();
          expect(tabs).toHaveLength(2);
          const moving = tabs[1];

          const before = panes(store).length;
          expect(before).toBe(1);

          const newGroupId = actions.splitPaneGroupWithTab(
            wtId,
            orientation,
            placement,
            undefined,
            moving,
          );

          // The pane exists after the effects have run, not just in the value
          // the reducer handed back.
          expect(newGroupId).not.toBeNull();
          await tick();
          const groups = panes(store);
          expect(groups).toHaveLength(2);
          expect(groups.some((g) => g.id === newGroupId)).toBe(true);

          // …and the tab is in it, while the pane that was split keeps the
          // other one. A `before` placement used to hand every unclaimed tab
          // to the new group and leave the old one to be collapsed as empty.
          const resolved = resolveGroupTabs(store.paneLayout(), store.workbenchTabIds());
          expect(resolved.get(newGroupId!)).toEqual([moving]);
          const other = groups.find((g) => g.id !== newGroupId)!;
          expect(resolved.get(other.id)).toEqual([tabs[0]]);
        });
      });
    }
  }

  it("keeps an empty pane the keyboard split asked for", async () => {
    await withStore(async (store, wtId) => {
      const { actions } = store;
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "a" });
      // No tab to carry: the command still owes the user a pane to drop into.
      const newGroupId = actions.splitPaneGroupWithTab(wtId, "row", "after", undefined, null);
      expect(newGroupId).not.toBeNull();
      await tick();
      expect(panes(store)).toHaveLength(2);
    });
  });

  it("still collapses a pane once its last tab leaves", async () => {
    await withStore(async (store, wtId) => {
      const { actions } = store;
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "a" });
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "b" });
      const tabs = store.workbenchTabIds();
      const moving = tabs[1];

      const newGroupId = actions.splitPaneGroupWithTab(wtId, "row", "after", undefined, moving)!;
      await tick();
      expect(panes(store)).toHaveLength(2);

      // Send it back. The pane it leaves has now *lost* what it held, which is
      // the condition the collapse rule is actually about.
      const home = panes(store).find((g) => g.id !== newGroupId)!;
      actions.moveTabToPaneGroup(wtId, moving, home.id, null);
      await tick();
      expect(panes(store)).toHaveLength(1);
    });
  });

  /// The tree the *store* holds, not the one the reducer returned.
  ///
  /// `panes()` reads through `groupList`, which only ever looks at `kind`, so it
  /// cannot see a node that is a group and a split at the same time. That shape
  /// is exactly what this describes, so the assertion has to be on the raw node.
  function rawLayout(store: ReturnType<typeof createAppStore>, wtId: string) {
    return store.state.paneLayoutByWorktree[wtId] as unknown as Record<string, unknown>;
  }

  it("leaves no split fields behind when a collapse turns the root back into a group", async () => {
    await withStore(async (store, wtId) => {
      const { actions } = store;
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "a" });
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "b" });
      const moving = store.workbenchTabIds()[1];

      const newGroupId = actions.splitPaneGroupWithTab(wtId, "row", "after", undefined, moving)!;
      await tick();
      expect(rawLayout(store, wtId).kind).toBe("split");

      // Drag it back: the pane it leaves is collapsed by the prune effect, and
      // the root goes from a split to a group.
      const home = panes(store).find((g) => g.id !== newGroupId)!;
      actions.moveTabToPaneGroup(wtId, moving, home.id, null);
      await tick();

      // `setState(path, node)` *merges* a plain object into whatever sits at
      // that path rather than replacing it — so this used to be a node carrying
      // `kind: "group"` on top of the split's `orientation`, `ratios` and
      // `children`. `groupList` reported one group while the renderer still had
      // two panes to place, every pane measured 0px wide, and the workbench was
      // unusable until a reload. See `writePaneLayout`.
      const raw = rawLayout(store, wtId);
      expect(raw.kind).toBe("group");
      expect(raw.children).toBeUndefined();
      expect(raw.ratios).toBeUndefined();
      expect(raw.orientation).toBeUndefined();

      // And the surviving group really holds both tabs.
      const resolved = resolveGroupTabs(store.paneLayout(), store.workbenchTabIds());
      expect(resolved.get(home.id)).toHaveLength(2);
    });
  });

  it("collapses a pane when its last tab is closed", async () => {
    await withStore(async (store, wtId) => {
      const { actions } = store;
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "a" });
      actions.openCompareTab(wtId, { baseRef: "main", headRef: "b" });
      const moving = store.workbenchTabIds()[1];

      actions.splitPaneGroupWithTab(wtId, "row", "after", undefined, moving);
      await tick();
      expect(panes(store)).toHaveLength(2);

      actions.closeCompareTab(wtId, moving);
      await tick();
      expect(panes(store)).toHaveLength(1);
    });
  });
});
