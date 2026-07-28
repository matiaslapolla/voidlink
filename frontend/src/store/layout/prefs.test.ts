/// Panel geometry is the one preference a user can put into an unusable state
/// by dragging, so the clamp has to hold on the way out *and* on the way back
/// in. A rail persisted at 4000px would leave no workbench and no handle to
/// drag back — the failure this file exists to prevent.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, PANEL_BOUNDS, clampPanelWidth, parsePrefs } from "./prefs";

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
