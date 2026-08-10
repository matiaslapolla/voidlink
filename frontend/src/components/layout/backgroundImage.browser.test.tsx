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

const html = () => document.documentElement;

function withBackgroundImage(opacityPercent: number) {
  html().style.setProperty("--ui-bg-image", 'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")');
  html().style.setProperty("--ui-surface-opacity", `${opacityPercent}%`);
  html().setAttribute("data-bg-image", "");
  html().setAttribute("data-bg-fit", "cover");
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
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    try {
      const bg = getComputedStyle(root).backgroundImage;
      // Two layers, scrim first (it paints over the image beneath it).
      expect(bg).toMatch(/^linear-gradient/);
      expect(bg).toContain("url(");
      expect(getComputedStyle(root).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    } finally {
      root.remove();
    }
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
    // `SURFACE_OPACITY_MIN` is 20 and the maximum is 100; the visible result
    // has to differ at both ends, in both directions, or the slider is inert.
    const seen = new Set<number>();
    for (const percent of [20, 50, 80, 100]) {
      withBackgroundImage(percent);
      seen.add(paintedAlpha("--color-background"));
    }
    expect(seen.size).toBe(4);
    expect(Math.min(...seen)).toBeCloseTo(0.2, 1);
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
