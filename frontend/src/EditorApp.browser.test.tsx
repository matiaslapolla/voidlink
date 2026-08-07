/// The editor window's vertical-tab layout, mounted in a real browser.
///
/// `ui.tabOrientation: "vertical"` used to fork `<main>`'s own flex axis to
/// `flex-row` — which put `EditorStatusBar` (a full-width footer under the
/// tab strip *and* the editor surface in horizontal mode) into that same row
/// as a third column. A `shrink-0` status bar with no width of its own
/// shrinks to its content in a row, so it landed as a ~100px sliver wedged
/// against the editor's right edge: a dead region that read as a phantom
/// split, with the editor surface stopping short of the window edge to make
/// room for it. jsdom reports a zero rect for every element (see
/// `TabStrip.browser.test.tsx`'s header), so this — like the vertical strip's
/// own geometry — can only be proven in a real layout engine.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { mockTauri } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { useSettings } from "@/store/settings";
import type { EditorTabsSnapshot, WindowContext } from "@/api/windows";

vi.mock("@/components/editor/EditorHost", () => ({ EditorHost: () => null }));
vi.mock("@/components/editor/monaco", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadMonaco: () => new Promise(() => {}),
}));

import { EditorSurface } from "./EditorApp";

const REPO = "/repos/api";

const SNAPSHOT: EditorTabsSnapshot = {
  worktreeId: "wt-1",
  repoPath: REPO,
  files: [{ id: "f1", path: `${REPO}/README.md` }],
  diffs: [],
  conflicts: [],
  previews: [],
  pinned: [],
  active: { type: "file", id: "f1", path: `${REPO}/README.md` },
  reveal: null,
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
  return render(() => (
    <div style={{ width: "1440px", height: "900px" }}>
      <AppStoreContext.Provider value={store}>
        <EditorSurface embedded context={() => CONTEXT} tabs={() => SNAPSHOT} send={() => {}} />
      </AppStoreContext.Provider>
    </div>
  ));
}

describe("the editor window's vertical tab layout", () => {
  it("gives EditorStatusBar the full window width instead of squeezing it into a third column", async () => {
    useSettings().updateUi({ tabOrientation: "vertical" });
    mount();
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    const main = document.querySelector("main");
    if (!main) throw new Error("the editor's <main> did not mount");
    // `EditorStatusBar`'s outermost element carries `h-6` — the one selector
    // that is this bar and not the strip or the editor surface.
    const statusBar = main.querySelector<HTMLElement>(".h-6");
    if (!statusBar) throw new Error("EditorStatusBar did not mount");

    const mainRect = main.getBoundingClientRect();
    const barRect = statusBar.getBoundingClientRect();
    // The regression: a `shrink-0` sibling caught in the strip's `flex-row`
    // shrinks to its content width instead of spanning the window. Asserting
    // it matches `<main>`'s own width — not a fixed pixel count — is what
    // keeps this honest if the island's insets ever change.
    expect(barRect.width).toBeCloseTo(mainRect.width, 0);
    expect(barRect.left).toBeCloseTo(mainRect.left, 0);
  });

  it("lets the editor surface reach the window's right edge, tab column and all", async () => {
    useSettings().updateUi({ tabOrientation: "vertical" });
    mount();
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    const main = document.querySelector("main");
    if (!main) throw new Error("the editor's <main> did not mount");
    // The editor surface's own wrapper — see the `min-w-0 min-h-0` comment
    // beside it in `EditorApp.tsx`.
    const surface = main.querySelector<HTMLElement>(".overflow-hidden.min-w-0.min-h-0");
    if (!surface) throw new Error("the editor surface did not mount");

    const mainRect = main.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    // The regression put a squeezed status bar between the surface and the
    // island's right edge instead of under both — this is what "the whole
    // window width usable" comes down to.
    expect(surfaceRect.right).toBeCloseTo(mainRect.right, 0);
  });
});
