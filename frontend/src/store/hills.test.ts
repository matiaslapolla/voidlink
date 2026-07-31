/// The hill store, and the promise that makes it worth having: **every move is
/// recorded**. The positions are a `localStorage` blob anyone could have
/// written; the durable half is the log, and a caller that could move a dot
/// without writing an event would silently lose the history a check-in reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.fn();
vi.mock("@/store/journal", () => ({ record: (e: unknown) => record(e) }));

const written: Record<string, unknown> = {};
vi.mock("@/store/layout/persistence", () => ({
  STORAGE_KEYS: { hills: "voidlink-hills" },
  readJson: <T,>(_key: string, fallback: T) => fallback,
  writeJson: (key: string, value: unknown) => {
    written[key] = value;
  },
}));

import {
  addHillScope,
  allHillScopes,
  hillScopes,
  moveHillScope,
  removeHillScope,
  resetHills,
  reviveHills,
  setHillScopeDone,
} from "./hills";

const WS = "ws-1";

/// The events recorded so far, kind first.
function kinds(): string[] {
  return record.mock.calls.map((c) => (c[0] as { kind: string }).kind);
}

function lastEvent(): Record<string, unknown> {
  return record.mock.calls[record.mock.calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  record.mockReset();
  resetHills();
  record.mockReset();
});

afterEach(() => resetHills());

describe("adding", () => {
  it("starts a scope at the bottom of the hill and records it", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search", repo: "/api" });
    expect(id).toBeTruthy();
    const [scope] = hillScopes(WS);
    expect(scope.name).toBe("Search");
    expect(scope.position).toBe(0);
    expect(scope.done).toBe(false);
    expect(kinds()).toEqual(["hill.scope.added"]);
    expect(lastEvent().repo).toBe("/api");
  });

  it("trims the name", () => {
    addHillScope({ workspaceId: WS, name: "  Search  " });
    expect(hillScopes(WS)[0].name).toBe("Search");
  });

  /// A nameless dot on a hill is not recoverable information — it is a mystery
  /// the user then has to delete by hand.
  it("refuses a blank name rather than adding a placeholder", () => {
    expect(addHillScope({ workspaceId: WS, name: "   " })).toBeNull();
    expect(hillScopes(WS)).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps workspaces apart", () => {
    addHillScope({ workspaceId: "a", name: "One" });
    addHillScope({ workspaceId: "b", name: "Two" });
    expect(hillScopes("a").map((s) => s.name)).toEqual(["One"]);
    expect(allHillScopes()).toHaveLength(2);
  });
});

describe("moving", () => {
  it("records the move with both ends and the resulting phase", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search", now: 0 })!;
    record.mockReset();

    moveHillScope({ workspaceId: WS, scopeId: id, position: 0.8, now: 5_000 });

    expect(hillScopes(WS)[0].position).toBe(0.8);
    expect(hillScopes(WS)[0].updatedAt).toBe(5_000);
    expect(kinds()).toEqual(["hill.position.moved"]);
    const event = lastEvent();
    expect(event.summary).toBe("Search is over the hill — now making it happen");
    expect(event.data).toMatchObject({ from: 0, to: 0.8, phase: "downhill" });
  });

  /// Dragging calls this many times a second. Recording every pixel would bury
  /// the log under a thousand events describing one decision.
  it("writes nothing when the position did not change", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    moveHillScope({ workspaceId: WS, scopeId: id, position: 0.5 });
    record.mockReset();
    moveHillScope({ workspaceId: WS, scopeId: id, position: 0.5 });
    expect(record).not.toHaveBeenCalled();
  });

  it("clamps a position off the end of the hill", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    moveHillScope({ workspaceId: WS, scopeId: id, position: 4 });
    expect(hillScopes(WS)[0].position).toBe(1);
  });

  it("ignores a scope that is not there", () => {
    record.mockReset();
    moveHillScope({ workspaceId: WS, scopeId: "nope", position: 0.5 });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("finishing", () => {
  /// Where the work actually was when it shipped is information. Snapping the
  /// dot to the end would erase it.
  it("does not move the dot to the end", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    moveHillScope({ workspaceId: WS, scopeId: id, position: 0.6 });
    setHillScopeDone({ workspaceId: WS, scopeId: id, done: true });

    const [scope] = hillScopes(WS);
    expect(scope.done).toBe(true);
    expect(scope.position).toBe(0.6);
    expect(lastEvent().data).toMatchObject({ at: 0.6 });
  });

  /// A scope that vanished on completion would take the record of having
  /// finished with it.
  it("keeps a finished scope in the list", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    setHillScopeDone({ workspaceId: WS, scopeId: id, done: true });
    expect(hillScopes(WS)).toHaveLength(1);
  });

  it("records a reopen distinctly from a finish", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    setHillScopeDone({ workspaceId: WS, scopeId: id, done: true });
    setHillScopeDone({ workspaceId: WS, scopeId: id, done: false });
    expect(kinds()).toEqual([
      "hill.scope.added",
      "hill.scope.finished",
      "hill.scope.reopened",
    ]);
  });

  it("writes nothing when the state is already what was asked for", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    record.mockReset();
    setHillScopeDone({ workspaceId: WS, scopeId: id, done: false });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("removing", () => {
  it("drops the scope and records that tracking stopped", () => {
    const id = addHillScope({ workspaceId: WS, name: "Search" })!;
    removeHillScope({ workspaceId: WS, scopeId: id });
    expect(hillScopes(WS)).toEqual([]);
    expect(kinds()[1]).toBe("hill.scope.removed");
  });

  it("leaves the other scopes of the workspace alone", () => {
    const keep = addHillScope({ workspaceId: WS, name: "Keep" })!;
    const drop = addHillScope({ workspaceId: WS, name: "Drop" })!;
    removeHillScope({ workspaceId: WS, scopeId: drop });
    expect(hillScopes(WS).map((s) => s.id)).toEqual([keep]);
  });
});

describe("reviveHills", () => {
  it("reads back what was written", () => {
    const revived = reviveHills({
      ws: [{ id: "s", name: "Search", position: 0.4, updatedAt: 7, done: false }],
    });
    expect(revived.ws[0]).toMatchObject({ name: "Search", position: 0.4, workspaceId: "ws" });
  });

  /// This is user-editable JSON on disk. A malformed entry must cost that
  /// entry, not the workspace's whole chart.
  it("drops a malformed scope without losing its neighbours", () => {
    const revived = reviveHills({
      ws: [null, { name: "" }, "nonsense", { id: "ok", name: "Fine", position: 0.2 }],
    });
    expect(revived.ws.map((s) => s.name)).toEqual(["Fine"]);
  });

  it("repairs an out-of-range or non-numeric position", () => {
    const revived = reviveHills({
      ws: [
        { id: "a", name: "High", position: 9 },
        { id: "b", name: "Text", position: "half" },
      ],
    });
    expect(revived.ws.map((s) => s.position)).toEqual([1, 0]);
  });

  it("survives a blob that is not an object at all", () => {
    expect(reviveHills(null)).toEqual({});
    expect(reviveHills("[]")).toEqual({});
    expect(reviveHills({ ws: "not an array" })).toEqual({});
  });
});
