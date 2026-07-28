import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditorSessionStore,
  decodeSession,
  encodeSession,
  pruneEntries,
  sessionStorageKey,
  SESSION_LIMIT,
  type SessionEntry,
  type SessionStorage,
} from "./sessionRestore";

function entry(path: string, at: number): SessionEntry {
  return { path, state: { cursorState: [{ position: { lineNumber: at, column: 1 } }] }, at };
}

/// A plain-object stand-in for `localStorage`, so the store's behaviour is
/// testable without a DOM and its failure paths without a private-mode browser.
function fakeStorage(seed: Record<string, string> = {}): SessionStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("sessionStorageKey", () => {
  it("namespaces per workspace so two repos cannot collide", () => {
    expect(sessionStorageKey("/a")).not.toBe(sessionStorageKey("/b"));
    expect(sessionStorageKey("/a")).toContain("voidlink-editor-session");
  });
});

describe("pruneEntries", () => {
  it("keeps the most recently touched files", () => {
    const pruned = pruneEntries([entry("a", 1), entry("b", 3), entry("c", 2)], 2);
    expect(pruned.map((e) => e.path)).toEqual(["b", "c"]);
  });

  it("caps at the module limit by default", () => {
    const many = Array.from({ length: SESSION_LIMIT + 25 }, (_, i) => entry(`f${i}`, i));
    expect(pruneEntries(many)).toHaveLength(SESSION_LIMIT);
  });

  it("does not mutate its input", () => {
    const input = [entry("a", 1), entry("b", 3)];
    pruneEntries(input, 1);
    expect(input.map((e) => e.path)).toEqual(["a", "b"]);
  });
});

describe("encodeSession / decodeSession", () => {
  it("round-trips entries", () => {
    const entries = [entry("/x/a.ts", 10), entry("/x/b.ts", 20)];
    const decoded = decodeSession(encodeSession(entries));
    expect(decoded.map((e) => e.path).sort()).toEqual(["/x/a.ts", "/x/b.ts"]);
    expect(decoded.find((e) => e.path === "/x/a.ts")?.state).toEqual(entries[0].state);
  });

  it("prunes on the way out, so a payload written under an older limit shrinks", () => {
    const many = Array.from({ length: SESSION_LIMIT + 5 }, (_, i) => entry(`f${i}`, i));
    expect(decodeSession(encodeSession(many))).toHaveLength(SESSION_LIMIT);
  });

  // Every corrupt-input case must cost a scroll position, never an editor that
  // will not open — hence one assertion per failure mode rather than a sample.
  it.each([
    ["absent", null],
    ["not JSON", "{{{"],
    ["not an object", "42"],
    ["null", "null"],
    ["a wrong version", JSON.stringify({ version: 9, entries: [entry("a", 1)] })],
    ["entries that are not an array", JSON.stringify({ version: 1, entries: "nope" })],
  ])("returns nothing for %s", (_label, raw) => {
    expect(decodeSession(raw as string | null)).toEqual([]);
  });

  it("drops individual malformed rows but keeps the good ones", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        entry("/good.ts", 5),
        { path: "", state: {}, at: 1 },
        { path: "/no-state.ts", at: 1 },
        { path: "/null-state.ts", state: null, at: 1 },
        null,
        "nope",
      ],
    });
    expect(decodeSession(raw).map((e) => e.path)).toEqual(["/good.ts"]);
  });

  it("tolerates a row with no timestamp", () => {
    const raw = JSON.stringify({ version: 1, entries: [{ path: "/a.ts", state: { x: 1 } }] });
    expect(decodeSession(raw)).toEqual([{ path: "/a.ts", state: { x: 1 }, at: 0 }]);
  });
});

describe("EditorSessionStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hydrates from storage", () => {
    const storage = fakeStorage({
      [sessionStorageKey("/repo")]: encodeSession([entry("/repo/a.ts", 1)]),
    });
    const store = new EditorSessionStore("/repo", storage);
    expect(store.restore("/repo/a.ts")).toEqual(entry("/repo/a.ts", 1).state);
    expect(store.restore("/repo/missing.ts")).toBeNull();
  });

  it("hydrates empty from a corrupt payload rather than throwing", () => {
    const storage = fakeStorage({ [sessionStorageKey("/repo")]: "not json" });
    expect(() => new EditorSessionStore("/repo", storage)).not.toThrow();
    expect(new EditorSessionStore("/repo", storage).restore("/anything")).toBeNull();
  });

  it("coalesces writes: ten tab switches produce one flush", () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const store = new EditorSessionStore("/repo", storage);
    for (let i = 0; i < 10; i++) store.save(`/repo/f${i}.ts`, { i });
    expect(setItem).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(decodeSession(storage.data[sessionStorageKey("/repo")])).toHaveLength(10);
  });

  it("flush() writes immediately and cancels the pending timer", () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const store = new EditorSessionStore("/repo", storage);
    store.save("/repo/a.ts", { line: 3 });
    store.flush();
    expect(setItem).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("forgets a path when Monaco hands back a null view state", () => {
    const store = new EditorSessionStore("/repo", fakeStorage());
    store.save("/repo/a.ts", { line: 3 });
    expect(store.restore("/repo/a.ts")).not.toBeNull();
    store.save("/repo/a.ts", null);
    expect(store.restore("/repo/a.ts")).toBeNull();
  });

  it("survives a storage that throws on write", () => {
    const storage: SessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = new EditorSessionStore("/repo", storage);
    store.save("/repo/a.ts", { line: 1 });
    expect(() => store.flush()).not.toThrow();
    // Positions still work for the rest of the session.
    expect(store.restore("/repo/a.ts")).toEqual({ line: 1 });
  });

  it("works with no storage at all", () => {
    const store = new EditorSessionStore("/repo", null);
    store.save("/repo/a.ts", { line: 1 });
    expect(store.restore("/repo/a.ts")).toEqual({ line: 1 });
    expect(() => store.flush()).not.toThrow();
  });
});
