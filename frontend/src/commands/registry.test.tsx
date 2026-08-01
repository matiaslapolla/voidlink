import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  type Action,
  getAction,
  getActions,
  getVisibleActions,
  registerActionSource,
  registerActions,
  useActionSource,
  useActionSourceCatalog,
} from "./registry";

// Each test mints its own id prefix (via a counter) rather than reusing
// literal ids across tests — `actions` is module-level shared state (the two
// built-ins `git.commit-graph` and `settings.goto` register at import time
// and are never touched again), so a leaked registration from one test would
// corrupt the next one's assertions.
let nextId = 0;
const freshId = (label: string) => `test.${label}.${nextId++}`;

const action = (id: string, overrides: Partial<Action> = {}): Action => ({
  id,
  label: id,
  run: () => {},
  ...overrides,
});

describe("registerActions — the low-level primitive", () => {
  it("registers and deregisters by id", () => {
    const id = freshId("solo");
    const dispose = registerActions([action(id)]);
    expect(getAction(id)).toBeDefined();
    dispose();
    expect(getAction(id)).toBeUndefined();
  });

  it("re-registering the same id replaces it in place rather than duplicating it", () => {
    const id = freshId("replace");
    registerActions([action(id, { label: "first" })]);
    registerActions([action(id, { label: "second" })]);
    const matches = getActions().filter((a) => a.id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe("second");
  });

  it("getVisibleActions omits hidden entries but getAction still resolves them", () => {
    const id = freshId("hidden");
    registerActions([action(id, { hidden: true })]);
    expect(getAction(id)).toBeDefined();
    expect(getVisibleActions().some((a) => a.id === id)).toBe(false);
  });
});

/// `registerActionSource` + `useActionSourceCatalog` need an owner (the
/// composed effect they wire together), the same requirement `createOverlay`
/// consumers document in `overlay.test.ts`'s sibling suites.
///
/// `createEffect` runs on the microtask queue rather than synchronously
/// (unlike a plain `createSignal` read/write), so every assertion that
/// depends on the composed catalog having caught up waits one microtask
/// first — the same `await Promise.resolve()` `store/terminalWatch.test.ts`
/// uses for the same reason.
async function withCatalog<T>(fn: () => Promise<T> | T): Promise<T> {
  let disposeRoot!: () => void;
  const out = await new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      disposeRoot = dispose;
      useActionSourceCatalog();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject);
    });
  });
  disposeRoot();
  return out;
}

const flush = () => Promise.resolve();

describe("registerActionSource / useActionSourceCatalog — feature-contributed sources", () => {
  it("composes multiple sources into the catalog", async () => {
    await withCatalog(async () => {
      const a = freshId("a");
      const b = freshId("b");
      registerActionSource(10, () => [action(a)]);
      registerActionSource(20, () => [action(b)]);
      await flush();
      expect(getAction(a)).toBeDefined();
      expect(getAction(b)).toBeDefined();
    });
  });

  it("orders the composed catalog by priority, not by registration call order", async () => {
    await withCatalog(async () => {
      const low = freshId("low");
      const high = freshId("high");
      // Registered high-priority-number first, low-priority-number second —
      // if call order won, `high` would sort first.
      registerActionSource(200, () => [action(high)]);
      registerActionSource(5, () => [action(low)]);
      await flush();
      const ids = getActions().map((a) => a.id);
      expect(ids.indexOf(low)).toBeLessThan(ids.indexOf(high));
    });
  });

  it("breaks a priority tie by registration order", async () => {
    await withCatalog(async () => {
      const first = freshId("first");
      const second = freshId("second");
      registerActionSource(50, () => [action(first)]);
      registerActionSource(50, () => [action(second)]);
      await flush();
      const ids = getActions().map((a) => a.id);
      expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
    });
  });

  it("unregistering a source removes exactly its actions", async () => {
    await withCatalog(async () => {
      const kept = freshId("kept");
      const removed = freshId("removed");
      registerActionSource(30, () => [action(kept)]);
      const unregister = registerActionSource(30, () => [action(removed)]);
      await flush();
      expect(getAction(kept)).toBeDefined();
      expect(getAction(removed)).toBeDefined();
      unregister();
      await flush();
      expect(getAction(kept)).toBeDefined();
      expect(getAction(removed)).toBeUndefined();
    });
  });

  it("a dynamic source reacts to the state it closes over — the whole point of a source being a function", async () => {
    await withCatalog(async () => {
      const id = freshId("dynamic");
      const [enabled, setEnabled] = createSignal(false);
      registerActionSource(40, () =>
        enabled() ? [action(id, { label: "on" })] : [],
      );
      await flush();
      expect(getAction(id)).toBeUndefined();
      setEnabled(true);
      await flush();
      expect(getAction(id)).toBeDefined();
      expect(getAction(id)?.label).toBe("on");
      setEnabled(false);
      await flush();
      expect(getAction(id)).toBeUndefined();
    });
  });

  it("a source registered after the catalog is wired still takes effect on the next dependency change", async () => {
    await withCatalog(async () => {
      const [tick, setTick] = createSignal(0);
      const id = freshId("late");
      // Nothing has registered this source's dependency yet at wiring time —
      // `registerActionSource` itself is called here, after `withCatalog`
      // has already created the composing effect.
      registerActionSource(60, () => {
        tick();
        return [action(id)];
      });
      await flush();
      expect(getAction(id)).toBeDefined();
      setTick(1);
      await flush();
      expect(getAction(id)).toBeDefined();
    });
  });

  it("useActionSource ties the source's lifetime to onCleanup — a torn-down owner leaves nothing behind", async () => {
    // This is the shape every feature registration function (registerGitActions,
    // registerWorkspaceActions, …) actually uses, so it is worth covering
    // separately from the bare `registerActionSource` above: a feature that
    // gets unmounted must not leave a stale row a re-mount then duplicates.
    const id = freshId("owned");
    await withCatalog(async () => {
      let disposeInner!: () => void;
      createRoot((dispose) => {
        disposeInner = dispose;
        useActionSource(45, () => [action(id)]);
      });
      await flush();
      expect(getAction(id)).toBeDefined();
      disposeInner();
      await flush();
      expect(getAction(id)).toBeUndefined();
    });
  });
});
