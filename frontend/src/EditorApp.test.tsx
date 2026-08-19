/// The popped-out editor window's file tree, collapsing.
///
/// The window this covers is the one where browsing files matters most and the
/// one that had no collapse at all: hiding the tree removed the column and left
/// the only way back in the title bar. It collapses to `FilesRail` now — the
/// same rail the workbench sidebar uses — so the way back is where the panel
/// was.
///
/// **Two mocks, both at the Monaco boundary.** `loadMonaco()` dynamically
/// imports the real `monaco-editor`, which needs a layout engine, workers and a
/// canvas jsdom does not have; `EditorHost` is the component that mounts it.
/// Neither is anywhere near what this file asserts, and a test that had to boot
/// an editor to click a sidebar button would be testing the wrong thing. The
/// pending promise is deliberate — `loadMonaco` never resolving is the same
/// shape as a slow load, which the component already handles, rather than a
/// rejection it would log about.
///
/// Everything else runs for real: the Tauri stub covers `@/api/*`, so the tree,
/// the tab strip and the git panel mount as they do in the window.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { mockTauri } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, SIDEBAR_RAIL_WIDTH } from "@/store/layout";
import type { EditorTabsSnapshot, WindowContext } from "@/api/windows";

vi.mock("@/components/editor/EditorHost", () => ({ EditorHost: () => null }));
vi.mock("@/components/editor/monaco", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadMonaco: () => new Promise(() => {}),
}));

import { EditorSurface } from "./EditorApp";

const REPO = "/repos/api";

const EMPTY: EditorTabsSnapshot = {
  worktreeId: "wt-1",
  repoPath: REPO,
  files: [],
  diffs: [],
  conflicts: [],
  previews: [],
  pinned: [],
  active: null,
  reveal: null,
  findRequest: null,
};

const CONTEXT: WindowContext = {
  repoPath: REPO,
  worktreeId: "wt-1",
  branch: "main",
  workspaceName: "api",
  worktreeLabel: "main",
};

function mount() {
  mockTauri({
    git_repo_info: { currentBranch: "main", isClean: true },
    git_file_status: [],
    fs_list_dir: [],
  });
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <EditorSurface embedded context={() => CONTEXT} tabs={() => EMPTY} send={() => {}} />
    </AppStoreContext.Provider>
  ));
  const aside = container.querySelector("aside");
  if (!aside) throw new Error("the file tree column did not mount");
  return { aside };
}

const headerToggle = () => screen.getByRole("button", { name: /file tree/i });
const railButton = () => screen.getByRole("button", { name: "Show the file explorer" });
const widthOf = (el: Element) => (el as HTMLElement).style.width;

describe("the editor window's file tree", () => {
  it("offers a collapse control, expanded", () => {
    const { aside } = mount();
    const toggle = headerToggle();
    expect(toggle).toHaveAccessibleName("Collapse file tree");
    // A disclosure, not a mode: the panel is still there when collapsed.
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).not.toHaveAttribute("aria-pressed");
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(widthOf(aside)).toBe("240px");
  });

  it("collapses to the rail and gives the width to the editor", async () => {
    const user = userEvent.setup();
    const { aside } = mount();

    await user.click(headerToggle());

    expect(headerToggle()).toHaveAttribute("aria-expanded", "false");
    expect(widthOf(aside)).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    // The column is still there, with a way back in it — the failure this
    // replaces was a tree that vanished entirely.
    expect(railButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("expands again from the rail", async () => {
    const user = userEvent.setup();
    const { aside } = mount();

    await user.click(headerToggle());
    await user.click(railButton());

    expect(headerToggle()).toHaveAttribute("aria-expanded", "true");
    expect(widthOf(aside)).toBe("240px");
    expect(screen.queryByRole("button", { name: "Show the file explorer" })).toBeNull();
  });

  it("is reachable from the keyboard", async () => {
    const user = userEvent.setup();
    mount();
    headerToggle().focus();
    await user.keyboard("{Enter}");
    expect(railButton()).toBeInTheDocument();
    railButton().focus();
    await user.keyboard("{Enter}");
    expect(headerToggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("offers a resize handle, disabled with a reason once collapsed", async () => {
    const user = userEvent.setup();
    mount();
    const splitter = screen.getByRole("separator", { name: "File tree column width" });
    expect(splitter).not.toHaveAttribute("aria-disabled");

    await user.click(headerToggle());

    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(splitter).toHaveAttribute(
      "title",
      "The file tree is collapsed — expand it to resize",
    );
  });

  it("persists a dragged width across a fresh mount of the window", () => {
    localStorage.setItem(
      "voidlink-editor-prefs",
      JSON.stringify({ panels: { tree: 320 }, splitFraction: 0.5 }),
    );
    const { aside } = mount();
    expect(widthOf(aside)).toBe("320px");
  });
});
