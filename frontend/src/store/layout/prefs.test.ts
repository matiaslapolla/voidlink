/// Panel geometry is the one preference a user can put into an unusable state
/// by dragging, so the clamp has to hold on the way out *and* on the way back
/// in. A rail persisted at 4000px would leave no workbench and no handle to
/// drag back — the failure this file exists to prevent.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  GIT_SECTION_KEYS,
  PANEL_BOUNDS,
  SIDEBAR_RAIL_WIDTH,
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

  /// The fallback used to be `{ ...DEFAULT_PREFS }`, which shares every nested
  /// object with the module-level constant. `createStore` mutates what it is
  /// handed, so on a first run — no persisted blob, the one case that spread
  /// was for — resizing a panel rewrote the default panel widths for the
  /// lifetime of the process.
  it("hands out its own nested objects, not the defaults themselves", () => {
    const a = parsePrefs(null);
    const b = parsePrefs(null);
    expect(a.sidebarSections).not.toBe(DEFAULT_PREFS.sidebarSections);
    expect(a.panels).not.toBe(DEFAULT_PREFS.panels);
    expect(a.gitSections).not.toBe(DEFAULT_PREFS.gitSections);
    expect(a.gitSectionOrder).not.toBe(DEFAULT_PREFS.gitSectionOrder);
    expect(a.sidebarSections).not.toBe(b.sidebarSections);

    a.sidebarSections.files = false;
    a.panels.sidebar = 999;
    expect(DEFAULT_PREFS.sidebarSections.files).toBe(true);
    expect(DEFAULT_PREFS.panels.sidebar).toBe(PANEL_BOUNDS.sidebar.default);
    expect(parsePrefs(null).sidebarSections.files).toBe(true);
  });
});

/// Collapsing the file explorer is worth nothing if the width does not come
/// back. The rail is a render-time width and is never written to `panels`, so
/// what has to survive the revive path is a *pair*: the collapsed flag, and the
/// width the user last dragged to underneath it. A build that stored the rail's
/// 32px in `panels.sidebar` would look identical until the user expanded again
/// and found the default — which is why both halves are asserted together.
describe("file explorer collapse", () => {
  it("ships expanded", () => {
    expect(DEFAULT_PREFS.sidebarSections.files).toBe(true);
  });

  it("keeps the collapsed flag and the pre-collapse width together", () => {
    const prefs = parsePrefs({
      sidebarSections: { files: false, terminals: true },
      panels: { rail: 212, sidebar: 320, gitSidebar: 320 },
    });
    expect(prefs.sidebarSections.files).toBe(false);
    // Not the default (256) and not the rail width — the width the user left.
    expect(prefs.panels.sidebar).toBe(320);
    expect(prefs.panels.sidebar).not.toBe(PANEL_BOUNDS.sidebar.default);
  });

  it("gives a blob written before either key existed sensible defaults", () => {
    const prefs = parsePrefs({ diffMode: "split" });
    expect(prefs.sidebarSections).toEqual(DEFAULT_PREFS.sidebarSections);
    expect(prefs.panels.sidebar).toBe(PANEL_BOUNDS.sidebar.default);
  });

  it("revives a half-written sections blob one key at a time", () => {
    // A build that only knew about `files` still leaves `terminals` correct.
    expect(parsePrefs({ sidebarSections: { files: false } } as never).sidebarSections).toEqual({
      files: false,
      terminals: DEFAULT_PREFS.sidebarSections.terminals,
    });
  });

  it("keeps the rail narrower than any width the panel can be dragged to", () => {
    // Otherwise collapsing would *cost* the user width, which is the one thing
    // the gesture must never do.
    expect(SIDEBAR_RAIL_WIDTH).toBeLessThan(PANEL_BOUNDS.sidebar.min);
  });

  it("refuses to store the rail width as a panel width", () => {
    // The clamp is what makes "never written to `panels`" enforceable rather
    // than a convention: a build that tried would get the minimum back.
    expect(clampPanelWidth("sidebar", SIDEBAR_RAIL_WIDTH)).toBe(PANEL_BOUNDS.sidebar.min);
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
