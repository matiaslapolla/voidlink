/// Proof that the palette's "Blur active workspace" and the rail's eye
/// button are one code path, not two: both must resolve to
/// `actions.toggleWorkspaceBlurred`, so this asserts the *action* mutates the
/// same store field the button reads (`state.blurredWorkspaces`) rather than
/// a parallel flag of its own.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { getAction, useActionSourceCatalog } from "@/commands/registry";
import { registerWorkspaceActions } from "@/commands/workspaceActions";

function Sources() {
  registerWorkspaceActions();
  useActionSourceCatalog();
  return null;
}

describe("workspace.toggleBlur", () => {
  it("toggles the same state the rail's eye button writes", async () => {
    const store = createAppStore({ persist: false });
    render(() => (
      <AppStoreContext.Provider value={store}>
        <Sources />
      </AppStoreContext.Provider>
    ));

    await waitFor(() => expect(getAction("workspace.toggleBlur")).toBeDefined());

    const wsId = store.state.activeWorkspaceId;
    expect(store.state.blurredWorkspaces).not.toContain(wsId);

    getAction("workspace.toggleBlur")!.run();
    expect(store.state.blurredWorkspaces).toContain(wsId);

    // The same action run twice is the same toggle the button performs on a
    // second click — proof this is one flag, not one-per-caller.
    getAction("workspace.toggleBlur")!.run();
    expect(store.state.blurredWorkspaces).not.toContain(wsId);

    // And the store method the button calls directly agrees with the action:
    // running it after the action leaves the flag exactly where either call
    // alone would have.
    store.actions.toggleWorkspaceBlurred(wsId);
    expect(store.state.blurredWorkspaces).toContain(wsId);
  });
});
