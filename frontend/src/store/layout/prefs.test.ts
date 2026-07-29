/// Panel geometry is the one preference a user can put into an unusable state
/// by dragging, so the clamp has to hold on the way out *and* on the way back
/// in. A rail persisted at 4000px would leave no workbench and no handle to
/// drag back — the failure this file exists to prevent.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  GIT_SECTION_KEYS,
  PANEL_BOUNDS,
  clampPanelWidth,
  parseGitSectionOrder,
  parsePrefs,
} from "./prefs";

describe("panel widths", () => {
  it("defaults to today's layout", () => {
    expect(DEFAULT_PREFS.panels).toEqual({
      rail: PANEL_BOUNDS.rail.default,
      sidebar: PANEL_BOUNDS.sidebar.default,
      gitSidebar: PANEL_BOUNDS.gitSidebar.default,
    });
  });

  it("clamps to the panel's own bounds", () => {
    expect(clampPanelWidth("rail", 10)).toBe(PANEL_BOUNDS.rail.min);
    expect(clampPanelWidth("rail", 4000)).toBe(PANEL_BOUNDS.rail.max);
    expect(clampPanelWidth("gitSidebar", 400)).toBe(400);
  });

  it("falls back to the default rather than trusting a non-number", () => {
    expect(clampPanelWidth("sidebar", Number.NaN)).toBe(PANEL_BOUNDS.sidebar.default);
    expect(clampPanelWidth("sidebar", Number.POSITIVE_INFINITY)).toBe(
      PANEL_BOUNDS.sidebar.default,
    );
  });

  it("rounds, so the DOM never gets a sub-pixel width", () => {
    expect(clampPanelWidth("rail", 212.6)).toBe(213);
  });

  it("re-clamps state written by a build with different bounds", () => {
    const prefs = parsePrefs({
      panels: { rail: 9000, sidebar: 1, gitSidebar: 400 },
    } as never);
    expect(prefs.panels.rail).toBe(PANEL_BOUNDS.rail.max);
    expect(prefs.panels.sidebar).toBe(PANEL_BOUNDS.sidebar.min);
    expect(prefs.panels.gitSidebar).toBe(400);
  });

  it("gives a blob written before panels existed the defaults", () => {
    expect(parsePrefs({ diffMode: "split" }).panels).toEqual(DEFAULT_PREFS.panels);
  });
});

describe("prefs parsing", () => {
  it("rejects a value the UI has no branch for", () => {
    expect(parsePrefs({ diffMode: "sidebyside" } as never).diffMode).toBe("inline");
    expect(parsePrefs({ gitTab: "nope" } as never).gitTab).toBe("changes");
    expect(parsePrefs({ sidebarTab: "nope" } as never).sidebarTab).toBe("terminals");
  });

  it("falls back wholesale on a null blob", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

/// A persisted order is the one preference that can silently *hide* a section:
/// a key missing from the array would render nowhere, and a key this build
/// doesn't know would render nothing. Both are repaired rather than rejected,
/// so a user's arrangement survives a section being added or removed.
describe("git section order", () => {
  it("defaults to the shipped order", () => {
    expect(DEFAULT_PREFS.gitSectionOrder).toEqual(GIT_SECTION_KEYS);
  });

  it("keeps a saved arrangement", () => {
    const saved = ["history", "changes", "branches", "worktrees", "stack", "stashes", "openedDiffs"];
    expect(parseGitSectionOrder(saved)).toEqual(saved);
  });

  it("appends sections the saved order never heard of", () => {
    const out = parseGitSectionOrder(["history", "changes"]);
    expect(out.slice(0, 2)).toEqual(["history", "changes"]);
    expect(new Set(out)).toEqual(new Set(GIT_SECTION_KEYS));
    expect(out).toHaveLength(GIT_SECTION_KEYS.length);
  });

  it("drops keys this build does not know and duplicates", () => {
    const out = parseGitSectionOrder(["changes", "changes", "submodules", 7, null]);
    expect(out).toEqual([
      "changes",
      "branches",
      "worktrees",
      "stack",
      "stashes",
      "history",
      "openedDiffs",
    ]);
  });

  it("falls back on anything that is not an array", () => {
    expect(parseGitSectionOrder(null)).toEqual(GIT_SECTION_KEYS);
    expect(parseGitSectionOrder("changes")).toEqual(GIT_SECTION_KEYS);
    expect(parsePrefs({}).gitSectionOrder).toEqual(GIT_SECTION_KEYS);
  });
});
