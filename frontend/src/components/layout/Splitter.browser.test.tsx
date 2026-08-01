/// The splitter's *box*, mounted in a real browser.
///
/// This control is almost entirely a set of geometric promises, and `Splitter.tsx`'s
/// header states them as a list — an 8px hit area around a 1px rule, a visual
/// size that never changes on hover so nothing reflows, a focus ring that reads
/// at 8px without widening anything, and a strip that straddles the canvas gap
/// rather than sitting on a pane edge. Every one of those is a measurement, and
/// in jsdom every one of them measures zero.
///
/// The gap offset is the sharpest case: `inGap` positions the strip at
/// `calc(var(--island-gap) / 2 - 4px)`, a value with a custom property inside a
/// `calc()`. Nothing resolves that but a real cascade — jsdom hands back the
/// `calc(…)` string unevaluated — and `islandGapPx()` exists precisely because
/// the app asks the stylesheet for the same number at runtime.
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@solidjs/testing-library";
import { userEvent } from "vitest/browser";

import { Splitter, islandGapPx, type SplitterProps } from "./Splitter";

/// The token's authored value. Asserted against rather than read from, so the
/// test fails if `index.css` and this file ever disagree about the gap.
const GAP = 6;

function mount(props: Partial<SplitterProps> = {}) {
  const onResize = vi.fn();
  const { container } = render(() => (
    // `relative` because the splitter is `absolute`: without a positioned
    // ancestor it would resolve its offset against the viewport and every
    // measurement below would be about the page, not the pane.
    <div style={{ position: "relative", width: "400px", height: "300px" }}>
      <Splitter
        side="end"
        label="Test pane width"
        value={200}
        min={120}
        max={360}
        defaultValue={240}
        onResize={onResize}
        {...props}
      />
    </div>
  ));
  const host = container.firstElementChild as HTMLElement;
  // Scoped to this mount's own container rather than to `screen`: two
  // splitters comparing against each other is the whole shape of the gap test
  // below, and both are in the document at once.
  const handle = within(host).getByRole("separator", { name: /pane width/i });
  return { handle, host, onResize };
}

/// The 1px rule inside the strip. First child, and the only element in there
/// with a real background — the second is the focus overlay.
const ruleOf = (handle: HTMLElement) => handle.children[0] as HTMLElement;
const focusRingOf = (handle: HTMLElement) => handle.children[1] as HTMLElement;

describe("the hit area (§7.6)", () => {
  /// The floor the guideline sets, and the reason the strip and the rule are
  /// two different elements at all: a 1px control is unhittable and an 8px
  /// visible seam is a scar down the middle of the window.
  it("is 8px wide around a rule that is 1px wide", () => {
    const { handle } = mount();
    const strip = handle.getBoundingClientRect();
    const rule = ruleOf(handle).getBoundingClientRect();

    expect(strip.width).toBeGreaterThanOrEqual(8);
    expect(rule.width).toBeLessThanOrEqual(1.5);
    // …and the rule really is inside the strip, rather than the strip having
    // collapsed to nothing beside it.
    expect(rule.left).toBeGreaterThanOrEqual(strip.left - 0.5);
    expect(rule.right).toBeLessThanOrEqual(strip.right + 0.5);
  });

  it("spans the full height of the pane it divides", () => {
    const { handle, host } = mount();
    expect(handle.getBoundingClientRect().height).toBeCloseTo(
      host.getBoundingClientRect().height,
      0,
    );
  });

  /// The horizontal splitter is the same control turned ninety degrees, and
  /// the 8px floor has to survive the rotation.
  it("is 8px tall on the y axis", () => {
    const { handle } = mount({ axis: "y", side: "end" });
    const strip = handle.getBoundingClientRect();
    expect(strip.height).toBeGreaterThanOrEqual(8);
    expect(ruleOf(handle).getBoundingClientRect().height).toBeLessThanOrEqual(1.5);
  });
});

describe("no layout shift (§7.6)", () => {
  /// "The visual size never changes on hover, so nothing reflows." A splitter
  /// that fattened under the cursor would nudge the pane beside it every time
  /// the pointer crossed the seam — and the only transition allowed here is
  /// `background-color`.
  it("changes colour on hover and nothing else", async () => {
    const { handle } = mount();
    const rule = ruleOf(handle);
    const before = rule.getBoundingClientRect();
    const colourBefore = getComputedStyle(rule).backgroundColor;

    await userEvent.hover(handle);
    await vi.waitFor(() =>
      expect(getComputedStyle(rule).backgroundColor).not.toBe(colourBefore),
    );

    const after = rule.getBoundingClientRect();
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(handle.getBoundingClientRect().width).toBeCloseTo(8, 1);
  });

  /// The focus ring is a separate inset overlay for the same reason: a ring
  /// drawn on the strip itself would have to widen it.
  it("draws the focus ring inside the strip without widening it", () => {
    const { handle } = mount();
    const before = handle.getBoundingClientRect();
    const ring = focusRingOf(handle);
    expect(getComputedStyle(ring).opacity).toBe("0");

    handle.focus();
    expect(getComputedStyle(ring).opacity).toBe("1");

    const after = handle.getBoundingClientRect();
    expect(after.width).toBeCloseTo(before.width, 1);
    // `inset-0`: the ring covers the whole hit area, which is what makes an
    // 8px target read as focused rather than a 1px line.
    const ringBox = ring.getBoundingClientRect();
    expect(ringBox.width).toBeCloseTo(after.width, 1);
    expect(ringBox.height).toBeCloseTo(after.height, 1);
  });
});

describe("straddling the canvas gap (Direction D1)", () => {
  /// The one place JavaScript asks the cascade for a token. jsdom computes no
  /// custom properties, so `islandGapPx()` there returns its hard-coded
  /// fallback and this assertion could not distinguish a working read from a
  /// broken one.
  it("reads the gap token rather than falling back", () => {
    expect(islandGapPx()).toBe(GAP);
  });

  /// Flush, the strip hugs the pane's own edge — where the 1px border used to
  /// be. In the gap it is shifted so its 8px span straddles the channel
  /// instead, and `Splitter.tsx` states the target exactly: the strip spans
  /// `[-gap/2 - 4px, -gap/2 + 4px]` from the pane edge, i.e. an offset of
  /// `gap/2 - 4px`, which is negative for a 6px gap.
  ///
  /// Asserted as those two edges rather than as "1px past the border",
  /// because the arithmetic is the specification and a test that restated it
  /// loosely would survive the `calc()` losing its `var()`.
  it("straddles the seam instead of hugging the pane edge", () => {
    const { handle: flush, host } = mount();
    const hostRight = host.getBoundingClientRect().right;
    expect(flush.getBoundingClientRect().right).toBeCloseTo(hostRight, 0);

    const { handle: inGap, host: host2 } = mount({ inGap: true });
    const edge = host2.getBoundingClientRect().right;
    const strip = inGap.getBoundingClientRect();

    expect(strip.left - edge).toBeCloseTo(-GAP / 2 - 4, 0);
    expect(strip.right - edge).toBeCloseTo(-GAP / 2 + 4, 0);
    // Which puts its centre half a gap off the edge — the middle of the
    // channel — and leaves the 8px hit area intact.
    expect(strip.left + strip.width / 2 - edge).toBeCloseTo(-GAP / 2, 0);
    expect(strip.width).toBeCloseTo(8, 1);
  });

  /// Flush, the rule lines up with the pane border it replaced. In a gap there
  /// is no border to line up with, so it is centred in the strip — and
  /// therefore in the gap.
  it("centres the rule in the strip once it is in the gap", () => {
    const { handle } = mount({ inGap: true });
    const strip = handle.getBoundingClientRect();
    const rule = ruleOf(handle).getBoundingClientRect();
    const stripCentre = strip.left + strip.width / 2;
    const ruleCentre = rule.left + rule.width / 2;
    expect(ruleCentre).toBeCloseTo(stripCentre, 0);
  });

  it("pins the rule to the pane edge when it is not", () => {
    const { handle } = mount();
    const strip = handle.getBoundingClientRect();
    const rule = ruleOf(handle).getBoundingClientRect();
    // `right-0` for an `end`-side handle: flush with the strip's outer edge,
    // measurably *not* its centre.
    expect(rule.right).toBeCloseTo(strip.right, 0);
    expect(Math.abs(rule.left - (strip.left + strip.width / 2))).toBeGreaterThan(2);
  });
});

describe("a disabled splitter", () => {
  /// Three channels plus a reason (§7.6 forbids a silent disabled control).
  /// The opacity is the one only a cascade can confirm.
  it("dims without resizing itself", () => {
    const { handle } = mount({ disabledReason: "The pane is collapsed" });
    expect(getComputedStyle(handle).opacity).toBe("0.4");
    expect(getComputedStyle(handle).cursor).toBe("not-allowed");
    expect(handle.getBoundingClientRect().width).toBeCloseTo(8, 1);
    expect(handle).toHaveAttribute("aria-disabled", "true");
    expect(handle).toHaveAttribute("title", "The pane is collapsed");
  });

  it("keeps the resize cursor when it is live", () => {
    const { handle } = mount();
    expect(getComputedStyle(handle).cursor).toBe("col-resize");
    expect(getComputedStyle(mount({ axis: "y" }).handle).cursor).toBe("row-resize");
  });
});
