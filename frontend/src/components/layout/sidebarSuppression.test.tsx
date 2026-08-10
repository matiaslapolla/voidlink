/// The third reason a sidebar can be off screen, beside zen and detaching:
/// the arrangement makes it redundant. Today that is the terminals list under
/// vertical tabs — the tab column already *is* the terminals list.
///
/// Tested at the predicate rather than through the shell because both callers
/// read this one function: `App.tsx` decides whether to render the panel, and
/// `TitleBar` decides whether its edge button may target it. The bug the
/// predicate exists to prevent is those two disagreeing.
import { afterEach, describe, expect, it } from "vitest";
import { useSettings, DEFAULT_SETTINGS } from "@/store/settings";
import { sidebarSuppressedReason } from "./SidebarDock";

afterEach(() => useSettings().updateUi({ ...DEFAULT_SETTINGS.ui }));

describe("sidebarSuppressedReason", () => {
  it("suppresses nothing while tabs run horizontally", () => {
    useSettings().updateUi({ tabOrientation: "horizontal" });
    for (const id of ["workspaces", "explorer", "terminals", "git", "agents"] as const) {
      expect(sidebarSuppressedReason(id)).toBeNull();
    }
  });

  it("suppresses the terminals list — and only it — under vertical tabs", () => {
    useSettings().updateUi({ tabOrientation: "vertical" });
    expect(sidebarSuppressedReason("terminals")).toMatch(/vertical/i);
    expect(sidebarSuppressedReason("explorer")).toBeNull();
    expect(sidebarSuppressedReason("git")).toBeNull();
    expect(sidebarSuppressedReason("workspaces")).toBeNull();
    expect(sidebarSuppressedReason("agents")).toBeNull();
  });

  /// Suppression is not a collapse: it persists nothing, so switching back
  /// gives the panel to the user in the state they left it in.
  it("is reversible with no state of its own", () => {
    useSettings().updateUi({ tabOrientation: "vertical" });
    useSettings().updateUi({ tabOrientation: "horizontal" });
    expect(sidebarSuppressedReason("terminals")).toBeNull();
  });
});
