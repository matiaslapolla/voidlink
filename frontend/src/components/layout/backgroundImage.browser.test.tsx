/// The background image and the opacity slider, against the real cascade.
///
/// This lives in the browser project and nowhere else for one reason:
/// `color-mix(in oklab, ...)` and custom-property inheritance are the whole
/// mechanism, and jsdom resolves neither — it hands back the literal
/// `color-mix(...)` string, or nothing at all, so a `render` test here would
/// pass against a feature that does not work.
///
/// It exists because the bug it locks down was invisible to every other kind of
/// test: `index.css` painted the image on `#root` and `AppShell.tsx`'s root
/// element covered it with an opaque `bg-canvas` rectangle, so the image had
/// never been visible once and the opacity slider looked inert. Nothing was
/// wrong with either file on its own.
import { describe, expect, it, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { AppShell } from "./AppShell";
import { DEFAULT_SETTINGS, scrimOpacityFor } from "@/store/settings";

const DEFAULT_STRENGTH = DEFAULT_SETTINGS.ui.backgroundStrength;

const html = () => document.documentElement;

function withBackgroundImage(opacityPercent: number, strengthPercent = DEFAULT_STRENGTH) {
  html().style.setProperty("--ui-bg-image", 'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")');
  html().style.setProperty("--ui-surface-opacity", `${opacityPercent}%`);
  html().style.setProperty("--ui-bg-scrim", `${scrimOpacityFor(strengthPercent)}%`);
  html().setAttribute("data-bg-image", "");
  html().setAttribute("data-bg-fit", "cover");
}

/// A `#root` in the document, so the scrim rule (`html[data-bg-image] #root`)
/// has something to match.
function withRoot<T>(fn: (root: HTMLElement) => T): T {
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  try {
    return fn(root);
  } finally {
    root.remove();
  }
}

/// Alpha of the scrim gradient `#root` paints over the photo. The gradient's
/// stops are `color-mix(in oklab, var(--canvas) var(--ui-bg-scrim), transparent)`,
/// resolved by the engine into the computed `background-image` — so the alpha
/// is read out of the first colour the layer names.
function scrimAlpha(root: HTMLElement): number {
  const layer = getComputedStyle(root).backgroundImage;
  const color = layer.match(/linear-gradient\((?:[^,]*,\s*)?((?:oklab|rgba?|color)\([^)]*\))/);
  if (!color) throw new Error(`no gradient colour in: ${layer}`);
  return alphaOf(color[1]);
}

/// Alpha of a computed colour, whichever notation the engine reports it in.
///
/// Chromium keeps a `color-mix(in oklab, ...)` result in oklab — the computed
/// value comes back as `oklab(0.2 0 -0.005 / 0.2)`, not as `rgba()`. A plain
/// `transparent` still computes to `rgba(0, 0, 0, 0)`. Both forms put alpha
/// after a `/`, or last in a four-part comma list, or nowhere at all (opaque).
function alphaOf(color: string): number {
  const m = /^[a-z]+\(([^)]*)\)$/.exec(color.trim());
  if (!m) throw new Error(`not a colour function: ${color}`);
  const [components, alpha] = m[1].split("/");
  if (alpha !== undefined) return Number.parseFloat(alpha);
  const parts = components.split(",").map((s) => s.trim());
  return parts.length < 4 ? 1 : Number.parseFloat(parts[3]);
}

/// The alpha a token actually paints with.
///
/// Not `getComputedStyle(html).getPropertyValue(token)`: custom properties are
/// untyped, so that returns the *specified* text — `color-mix(in oklab, ...)`,
/// unresolved. The resolution only happens when the value is used as a real
/// property, so this paints it on a throwaway element and reads that back.
function paintedAlpha(token: string): number {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  try {
    return alphaOf(getComputedStyle(probe).backgroundColor);
  } finally {
    probe.remove();
  }
}

afterEach(() => {
  html().removeAttribute("data-bg-image");
  html().removeAttribute("data-bg-fit");
  html().style.removeProperty("--ui-bg-image");
  html().style.removeProperty("--ui-surface-opacity");
  html().style.removeProperty("--ui-bg-scrim");
});

describe("the background image is actually visible", () => {
  it("leaves --color-canvas opaque when no image is set", () => {
    // The default shell: the canvas is the window's own surface and nothing
    // shows through it.
    expect(paintedAlpha("--color-canvas")).toBe(1);
  });

  it("makes the canvas fully transparent once an image is set", () => {
    // This is the fix. `AppShell`'s root carries `bg-canvas` and fills the
    // viewport; while this stayed opaque the image behind it was unreachable.
    withBackgroundImage(100);
    expect(paintedAlpha("--color-canvas")).toBe(0);
  });

  it("paints the image on #root, under the scrim", () => {
    withBackgroundImage(100);
    withRoot((root) => {
      const bg = getComputedStyle(root).backgroundImage;
      // Two layers, scrim first (it paints over the image beneath it).
      expect(bg).toMatch(/^linear-gradient/);
      expect(bg).toContain("url(");
      expect(getComputedStyle(root).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
  });

  /// The second half of the fix, and the one the *user* was asking for: the
  /// island slider only ever revealed the scrim, so with the scrim fixed the
  /// photo could not be brought forward at all. These lock down that the
  /// strength slider moves it and that the two ends are the measured band.
  it("thins the scrim as the image strength rises", () => {
    const alphas = [0, 25, 50, 75, 100].map((strength) =>
      withRoot((root) => {
        withBackgroundImage(100, strength);
        return scrimAlpha(root);
      }),
    );
    // Strictly decreasing: every position on the slider is a position.
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i], `strength step ${i}`).toBeLessThan(alphas[i - 1]);
    }
    expect(alphas[0]).toBeCloseTo(0.95, 2);
    expect(alphas[alphas.length - 1]).toBeCloseTo(0.25, 2);
  });

  it("falls back to the safe scrim when the property has not been applied yet", () => {
    // A window between module eval and the store's first effect. Painting no
    // scrim there would flash the photo at full strength under the chrome.
    withBackgroundImage(100);
    html().style.removeProperty("--ui-bg-scrim");
    withRoot((root) => expect(scrimAlpha(root)).toBeCloseTo(0.95, 2));
  });

  it("leaves the image visible at the default strength with the islands opaque", () => {
    // The default install: an image is picked and nothing else is touched. If
    // this ever goes back to ~0.95 the feature is inert again.
    withBackgroundImage(100);
    withRoot((root) => {
      expect(scrimAlpha(root)).toBeLessThan(0.7);
      expect(scrimAlpha(root)).toBeGreaterThan(0.5);
    });
  });

  it("gives the AppShell root a see-through background at every slider position", () => {
    withBackgroundImage(100);
    const { container } = render(() => (
      <AppShell titleBar={null} sidebars={[]} main={<div />} statusBar={<div />} />
    ));
    const shell = container.firstElementChild as HTMLElement;
    expect(alphaOf(getComputedStyle(shell).backgroundColor)).toBe(0);
  });

  it("moves the island surfaces across the slider's whole range", () => {
    // `SURFACE_OPACITY_MIN` is 0 and the maximum is 100; the visible result
    // has to differ at both ends, in both directions, or the slider is inert.
    const seen = new Set<number>();
    for (const percent of [0, 20, 50, 80, 100]) {
      withBackgroundImage(percent);
      seen.add(paintedAlpha("--color-background"));
    }
    expect(seen.size).toBe(5);
    expect(Math.min(...seen)).toBeCloseTo(0, 1);
    expect(Math.max(...seen)).toBeCloseTo(1, 1);
  });

  it("mixes the region surfaces too, so no panel stays opaque on its own", () => {
    withBackgroundImage(20);
    for (const token of [
      "--color-sidebar",
      "--color-card",
      "--color-popover",
      "--color-elev-1",
      "--color-elev-2",
      "--color-elev-3",
      "--color-surface-rail",
      "--color-surface-tabstrip",
      "--color-surface-statusbar",
    ]) {
      const alpha = paintedAlpha(token);
      expect(alpha, token).toBeGreaterThan(0);
      expect(alpha, token).toBeLessThan(1);
    }
  });
});
