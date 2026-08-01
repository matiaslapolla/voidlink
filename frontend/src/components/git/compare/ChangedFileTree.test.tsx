/// The compare tab's file tree, mounted.
///
/// From the 2026-07-30 audit's coverage backlog. This surface accumulated six
/// findings — CMP-F25 (collapse state resetting on every refetch), CMP-F26 (a
/// non-reactive `props.node.file!` read that fixing F25 would have turned into a
/// stale-data bug), CMP-F12 (a footer counting the wrong set), plus tree-key
/// collisions — and every one of them shipped without ever being mounted in a
/// test. These are those findings, as tests.
///
/// No Tauri stub needed: this component is a pure function of its props, which
/// is why it was worth testing first.
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { FileDiff } from "@/types/git";

import { ChangedFileTree } from "./ChangedFileTree";

function file(path: string, partial: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    hunks: [],
    isBinary: false,
    additions: 1,
    deletions: 0,
    oldBlobOid: null,
    ...partial,
  } as FileDiff;
}

function mount(files: FileDiff[], overrides: Partial<Parameters<typeof ChangedFileTree>[0]> = {}) {
  const onSelect = vi.fn();
  const onModeChange = vi.fn();
  const onFilterChange = vi.fn();
  const result = render(() => (
    <ChangedFileTree
      files={files}
      selectedPath={null}
      onSelect={onSelect}
      mode="tree"
      filter=""
      onModeChange={onModeChange}
      onFilterChange={onFilterChange}
      {...overrides}
    />
  ));
  return { ...result, onSelect, onModeChange, onFilterChange };
}

describe("tree shape", () => {
  it("nests files under their folders", () => {
    mount([file("src/parser/lex.ts"), file("README.md")]);
    expect(screen.getByText("lex.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // The chain `src/parser` has one folder child, so it compacts into one row.
    expect(screen.getByText("src/parser/")).toBeInTheDocument();
  });

  /// The compaction rule: a folder whose only child is a folder merges into it.
  /// Without this a deep repository renders eight rows of chevrons before the
  /// first file.
  it("compacts a chain of single-child folders into one row", () => {
    mount([file("a/b/c/d/leaf.ts")]);
    expect(screen.getByText("a/b/c/d/")).toBeInTheDocument();
    expect(screen.queryByText("a/")).not.toBeInTheDocument();
  });

  it("stops compacting where the tree actually branches", () => {
    // `a` has two folder children, so it cannot merge into either — the three
    // folders stay three rows. This is the boundary the compaction rule is
    // about: merging here would lose the fact that `b` and `c` are siblings.
    mount([file("a/b/one.ts"), file("a/c/two.ts")]);
    expect(screen.getByText("a/")).toBeInTheDocument();
    expect(screen.getByText("b/")).toBeInTheDocument();
    expect(screen.getByText("c/")).toBeInTheDocument();
  });

  /// A file at the root has no folder to hang from, and dropping it — or
  /// inventing an empty-labelled folder for it — is the shape of bug that makes
  /// a diff look smaller than it is.
  it("renders a root-level file with no folder row", () => {
    mount([file("LICENSE")]);
    expect(screen.getByText("LICENSE")).toBeInTheDocument();
  });

  /// A rename's identity is its *new* path. Keying on `oldPath` is what made
  /// two renamed files collide into one row.
  it("identifies a renamed file by its new path", () => {
    mount([file("src/new-name.ts", { oldPath: "src/old-name.ts", status: "renamed" })]);
    expect(screen.getByText("new-name.ts")).toBeInTheDocument();
    expect(screen.queryByText("old-name.ts")).not.toBeInTheDocument();
  });

  /// A deleted file has no `newPath`. Falling back to `oldPath` is the only way
  /// it appears at all.
  it("falls back to the old path for a deletion", () => {
    mount([file("src/gone.ts", { newPath: null, status: "deleted" })]);
    expect(screen.getByText("gone.ts")).toBeInTheDocument();
  });

  /// The other end of the compaction rule, and the one the audit read the
  /// wrong way round: a folder whose only child is a *file* still merges into
  /// its parent chain. `src/main/Foo.java` is one folder row, not two.
  it("compacts a chain that ends in a single file", () => {
    mount([file("src/main/Foo.java")]);
    expect(screen.getByText("src/main/")).toBeInTheDocument();
    expect(screen.queryByText("src/")).not.toBeInTheDocument();
    expect(screen.queryByText("main/")).not.toBeInTheDocument();
    expect(screen.getByText("Foo.java")).toBeInTheDocument();
  });

  /// ...but the last folder does not swallow the file itself. `src/main/` and
  /// `Foo.java` are two rows, because the file is what gets clicked and a row
  /// that is both a folder and a file has no sensible click target.
  it("does not merge a folder into the file underneath it", () => {
    mount([file("src/Foo.java")]);
    const rows = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(rows.some((t) => t.includes("src/Foo.java"))).toBe(false);
  });

  /// CMP-F6. A commit can turn a file into a directory, and then a single diff
  /// contains both: `swap` deleted as a file and `swap/inner.ts` added beneath
  /// a directory of the same name. Both nodes carried `path: "swap"`, so
  /// anything keyed on the path could not say which row it meant — which is
  /// why folders now key on the path plus a trailing slash.
  it("keeps a file and a directory of the same name apart", () => {
    mount([
      file("swap", { newPath: null, status: "deleted" }),
      file("swap/inner.ts", { oldPath: null, status: "added" }),
    ]);
    expect(screen.getByText("swap/")).toBeInTheDocument();
    expect(screen.getByText("swap")).toBeInTheDocument();
    expect(screen.getByText("inner.ts")).toBeInTheDocument();
    expect(screen.getByText(/^2 files$/)).toBeInTheDocument();
  });

  /// The consequence that made the shared key worth fixing: collapse state is
  /// keyed on it, so a collapsed directory must not take the file of the same
  /// name down with it.
  it("collapsing that directory leaves the file of the same name alone", async () => {
    const user = userEvent.setup();
    mount([
      file("swap", { newPath: null, status: "deleted" }),
      file("swap/inner.ts", { oldPath: null, status: "added" }),
    ]);

    await user.click(screen.getByText("swap/"));
    expect(screen.queryByText("inner.ts")).not.toBeInTheDocument();
    expect(screen.getByText("swap")).toBeInTheDocument();
  });

  it("says so rather than rendering an empty pane when nothing changed", () => {
    mount([]);
    expect(screen.getByText(/no differences/i)).toBeInTheDocument();
  });
});

describe("rollups", () => {
  /// A folder's counts are the sum of its descendants. Getting this wrong makes
  /// a folder look untouched when a file three levels down changed by 400 lines.
  it("aggregates line counts up the tree", () => {
    mount([
      file("src/a.ts", { additions: 10, deletions: 2 }),
      file("src/b.ts", { additions: 5, deletions: 3 }),
    ]);
    const row = screen.getByText("src/").closest("button")!;
    expect(within(row).getByText(/\+15/)).toBeInTheDocument();
    expect(within(row).getByText(/−5|-5/)).toBeInTheDocument();
  });
});

describe("selection", () => {
  it("reports the path the user clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount([file("src/a.ts")]);
    await user.click(screen.getByText("a.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });
});

describe("filtering", () => {
  it("narrows to matching paths", () => {
    mount([file("src/parser.ts"), file("src/lexer.ts")], { filter: "parser" });
    expect(screen.getByText("parser.ts")).toBeInTheDocument();
    expect(screen.queryByText("lexer.ts")).not.toBeInTheDocument();
  });

  it("matches on the whole path, not just the file name", () => {
    mount([file("src/parser/index.ts"), file("src/lexer/index.ts")], { filter: "parser" });
    expect(screen.getAllByText("index.ts")).toHaveLength(1);
  });

  it("reports what the user typed rather than filtering itself", async () => {
    const user = userEvent.setup();
    const { onFilterChange } = mount([file("src/a.ts")]);
    await user.type(screen.getByRole("textbox", { name: /filter changed files/i }), "x");
    expect(onFilterChange).toHaveBeenCalledWith("x");
  });
});

/// CMP-F25, as a test.
///
/// `buildTree` allocates all-new nodes on every render, `<For>` keys by object
/// identity, and so every row is disposed and recreated — taking any state
/// inside it along. Collapse state therefore has to be keyed on *paths*, which
/// outlive the nodes. With the filesystem watcher running, a pulse arrives
/// often enough that the old behaviour meant folders sprang open while you were
/// reading them.
describe("collapse state", () => {
  it("collapses a folder and hides its children", async () => {
    const user = userEvent.setup();
    mount([file("src/a.ts")]);
    expect(screen.getByText("a.ts")).toBeInTheDocument();

    await user.click(screen.getByText("src/"));
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  /// The finding itself. `buildTree` allocates all-new nodes, `<For>` keys by
  /// object identity, so a refetch disposes and recreates every row. State held
  /// *inside* a row therefore dies with it — which is why this is keyed on the
  /// path instead.
  ///
  /// Driven through a signal so the component really re-renders against a fresh
  /// array of fresh objects, exactly as a git pulse produces. A test that
  /// re-mounted instead would prove nothing: a remount is supposed to reset.
  it("survives the file list being rebuilt underneath it", async () => {
    const user = userEvent.setup();
    const [files, setFiles] = createSignal<FileDiff[]>([file("src/a.ts")]);
    render(() => (
      <ChangedFileTree
        files={files()}
        selectedPath={null}
        onSelect={() => {}}
        mode="tree"
        filter=""
        onModeChange={() => {}}
        onFilterChange={() => {}}
      />
    ));

    await user.click(screen.getByText("src/"));
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();

    // The pulse: same paths, all-new objects.
    setFiles([file("src/a.ts")]);
    await waitFor(() => expect(screen.getByText("src/")).toBeInTheDocument());
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  /// A folder appearing for the first time defaults to open — which is why the
  /// state is a collapsed-set rather than an open-set.
  it("opens a folder that was not there before", () => {
    mount([file("src/a.ts"), file("docs/b.md")]);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });
});
