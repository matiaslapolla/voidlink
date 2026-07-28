import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import type { SearchMatch, SearchSummary } from "@/api/fs";
import {
  applyReplacements,
  createFindController,
  describeEmpty,
  describeResults,
  describeTruncated,
  groupByFile,
  type FindTransport,
} from "./findInFiles";

function match(path: string, line: number): SearchMatch {
  return { path, line, column: 1, preview: "x", previewColumn: 1, length: 1 };
}

function summary(over: Partial<SearchSummary> = {}): SearchSummary {
  return {
    filesScanned: 0,
    filesMatched: 0,
    matches: 0,
    truncated: false,
    cancelled: false,
    errors: [],
    ...over,
  };
}

/// A transport whose searches resolve when the test says so, which is the only
/// way to observe the states between "started" and "finished".
function deferredTransport() {
  const started: string[] = [];
  const cancelled: string[] = [];
  const resolvers = new Map<string, (s: SearchSummary) => void>();
  const rejecters = new Map<string, (e: unknown) => void>();
  const transport: FindTransport = {
    search(id) {
      started.push(id);
      return new Promise<SearchSummary>((resolve, reject) => {
        resolvers.set(id, resolve);
        rejecters.set(id, reject);
      });
    },
    cancel(id) {
      cancelled.push(id);
      return Promise.resolve();
    },
  };
  return {
    transport,
    started,
    cancelled,
    finish: (id: string, s: SearchSummary) => resolvers.get(id)!(s),
    fail: (id: string, e: unknown) => rejecters.get(id)!(e),
  };
}

describe("groupByFile", () => {
  it("groups in first-seen order and keeps match order inside a file", () => {
    const grouped = groupByFile([
      match("/b.rs", 1),
      match("/a.rs", 9),
      match("/b.rs", 4),
    ]);
    expect(grouped.map((g) => g.path)).toEqual(["/b.rs", "/a.rs"]);
    expect(grouped[0].matches.map((m) => m.line)).toEqual([1, 4]);
  });

  it("handles a file whose matches straddle two batches", () => {
    // The reason grouping is not done in Rust: a batch boundary can fall
    // inside a file, so only the accumulated list can be grouped correctly.
    const grouped = groupByFile([match("/a.rs", 1), match("/b.rs", 1), match("/a.rs", 2)]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].matches).toHaveLength(2);
  });

  it("is empty for no matches", () => {
    expect(groupByFile([])).toEqual([]);
  });
});

describe("state descriptions", () => {
  it("names the query and the scope in the no-match line", () => {
    // MASTER §9.7: a bare "No results" hides the usual cause, which is a scope
    // the user did not expect.
    expect(describeEmpty("foo", summary({ filesScanned: 1204 }))).toBe(
      'No matches for "foo" in 1,204 files',
    );
    expect(describeEmpty("foo", summary({ filesScanned: 1 }))).toBe(
      'No matches for "foo" in 1 file',
    );
  });

  it("reports truncation with the real number", () => {
    expect(describeTruncated(summary({ matches: 2000 }))).toBe(
      "Showing the first 2,000 matches — there are more",
    );
  });

  it("pluralises the results header correctly", () => {
    expect(describeResults(summary({ matches: 1, filesMatched: 1 }))).toBe("1 match in 1 file");
    expect(describeResults(summary({ matches: 12, filesMatched: 3 }))).toBe(
      "12 matches in 3 files",
    );
  });
});

describe("applyReplacements", () => {
  function at(line: number, column: number, length: number): SearchMatch {
    return { path: "/a.rs", line, column, preview: "", previewColumn: 1, length };
  }

  it("replaces every recorded match", () => {
    const out = applyReplacements("a foo b\nfoo\n", [at(1, 3, 3), at(2, 1, 3)], "foo", "bar");
    expect(out.text).toBe("a bar b\nbar\n");
    expect(out.applied).toBe(2);
    expect(out.skipped).toBe(0);
  });

  it("applies bottom-up so a length change cannot shift a later match", () => {
    // Two matches on one line, replaced with something longer. Top-down would
    // put the second replacement in the wrong place.
    const out = applyReplacements("foo foo", [at(1, 1, 3), at(1, 5, 3)], "foo", "quux");
    expect(out.text).toBe("quux quux");
    expect(out.applied).toBe(2);
  });

  it("skips a match whose position no longer holds the text", () => {
    // The file changed between the walk and the click. Rewriting blind here is
    // how replace-all corrupts a file.
    const out = applyReplacements("something else\n", [at(1, 1, 3)], "foo", "bar");
    expect(out.text).toBe("something else\n");
    expect(out.applied).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it("skips a match past the end of the file", () => {
    const out = applyReplacements("one line\n", [at(99, 1, 3)], "foo", "bar");
    expect(out.skipped).toBe(1);
  });

  it("honours the case the search folded", () => {
    // A case-insensitive search matched `Foo`; replacing it is still correct.
    const out = applyReplacements("Foo\n", [at(1, 1, 3)], "foo", "bar");
    expect(out.text).toBe("bar\n");
    expect(out.applied).toBe(1);
  });

  it("keeps columns aligned on lines with astral characters", () => {
    const out = applyReplacements("😀 foo", [at(1, 3, 3)], "foo", "bar");
    expect(out.text).toBe("😀 bar");
  });
});

describe("createFindController", () => {
  it("starts idle — not at 'no results'", () => {
    createRoot((dispose) => {
      const c = createFindController(deferredTransport().transport);
      expect(c.state().kind).toBe("idle");
      expect(c.matches()).toEqual([]);
      dispose();
    });
  });

  it("enters searching and streams matches in before the walk ends", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      void c.run("/repo", "needle");

      expect(c.state()).toEqual({ kind: "searching", query: "needle" });
      c.acceptBatch({ searchId: "s1", seq: 0, matches: [match("/a.rs", 1)] });
      // The count updates live rather than waiting for the traversal.
      expect(c.matchCount()).toBe(1);
      expect(c.state().kind).toBe("searching");

      c.acceptBatch({ searchId: "s1", seq: 1, matches: [match("/a.rs", 2)] });
      expect(c.groups()[0].matches).toHaveLength(2);
      dispose();
    });
  });

  it("settles into results with the summary", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      const done = c.run("/repo", "needle");
      t.finish("s1", summary({ matches: 3, filesMatched: 2, filesScanned: 10 }));
      await done;
      expect(c.state().kind).toBe("results");
      expect(c.matchCount()).toBe(3);
      dispose();
    });
  });

  it("distinguishes no-matches from results", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      const done = c.run("/repo", "needle");
      t.finish("s1", summary({ filesScanned: 1204 }));
      await done;
      const s = c.state();
      expect(s.kind).toBe("empty");
      if (s.kind === "empty") expect(s.summary.filesScanned).toBe(1204);
      dispose();
    });
  });

  it("surfaces a failure inline with the query that caused it", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      const done = c.run("/repo", "needle");
      t.fail("s1", new Error("Not a directory: /repo"));
      await done;
      expect(c.state()).toEqual({
        kind: "error",
        query: "needle",
        message: "Not a directory: /repo",
      });
      dispose();
    });
  });

  it("re-runs the last query on retry", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      let n = 0;
      const c = createFindController(t.transport, () => `s${++n}`);
      const first = c.run("/repo", "needle");
      t.fail("s1", new Error("boom"));
      await first;

      const again = c.retry();
      expect(c.state()).toEqual({ kind: "searching", query: "needle" });
      t.finish("s2", summary({ matches: 1, filesMatched: 1 }));
      await again;
      expect(c.state().kind).toBe("results");
      dispose();
    });
  });

  // ── Cancellation. The requirement the panel is most likely to get wrong.

  it("cancels the in-flight walk when a new query starts", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      let n = 0;
      const c = createFindController(t.transport, () => `s${++n}`);
      void c.run("/repo", "first");
      void c.run("/repo", "second");
      expect(t.cancelled).toEqual(["s1"]);
      expect(t.started).toEqual(["s1", "s2"]);
      dispose();
    });
  });

  it("drops batches from a superseded search", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      let n = 0;
      const c = createFindController(t.transport, () => `s${++n}`);
      void c.run("/repo", "first");
      void c.run("/repo", "second");

      // The old walk was already inside a file read when the flag flipped, so
      // one last batch still arrives. It must not render.
      c.acceptBatch({ searchId: "s1", seq: 9, matches: [match("/stale.rs", 1)] });
      expect(c.matches()).toEqual([]);

      c.acceptBatch({ searchId: "s2", seq: 0, matches: [match("/fresh.rs", 1)] });
      expect(c.matches().map((m) => m.path)).toEqual(["/fresh.rs"]);
      dispose();
    });
  });

  it("ignores a superseded search's summary", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      let n = 0;
      const c = createFindController(t.transport, () => `s${++n}`);
      const first = c.run("/repo", "first");
      void c.run("/repo", "second");

      // The old walk finishes late. Its "no matches" must not overwrite the
      // searching state of the query the user is actually watching.
      t.finish("s1", summary({ filesScanned: 5 }));
      await first;
      expect(c.state()).toEqual({ kind: "searching", query: "second" });
      dispose();
    });
  });

  it("ignores a summary the walker marked cancelled", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      const done = c.run("/repo", "needle");
      t.finish("s1", summary({ cancelled: true }));
      await done;
      // Still searching from the user's point of view — nothing replaced it.
      expect(c.state().kind).toBe("searching");
      dispose();
    });
  });

  it("returns to idle on an empty query rather than searching for nothing", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      await c.run("/repo", "   ");
      expect(c.state().kind).toBe("idle");
      expect(t.started).toEqual([]);
      dispose();
    });
  });

  it("clear cancels and returns to idle", async () => {
    await createRoot(async (dispose) => {
      const t = deferredTransport();
      const c = createFindController(t.transport, () => "s1");
      void c.run("/repo", "needle");
      c.acceptBatch({ searchId: "s1", seq: 0, matches: [match("/a.rs", 1)] });
      c.clear();
      expect(t.cancelled).toEqual(["s1"]);
      expect(c.state().kind).toBe("idle");
      expect(c.matches()).toEqual([]);
      dispose();
    });
  });

  it("carries options into the search call", async () => {
    await createRoot(async (dispose) => {
      const seen: unknown[] = [];
      const transport: FindTransport = {
        search: (_id, _root, _q, options) => {
          seen.push(options);
          return Promise.resolve(summary());
        },
        cancel: () => Promise.resolve(),
      };
      const c = createFindController(transport, () => "s1");
      c.setOptions({ includeIgnored: true });
      await c.run("/repo", "needle");
      expect(seen).toEqual([{ includeIgnored: true }]);
      dispose();
    });
  });
});
