/// The splitter's keyboard and announcement contract, mounted.
///
/// The three hand-rolled `startResize` pairs this control replaced were none
/// of them focusable and none of them announced anything, and that is the half
/// of §7.6 that has nothing to do with pixels: a `separator` with live
/// `aria-valuenow`, arrows that step, `Shift` that steps further, `Home`/`End`
/// that reach the bounds, and a double-click that resets. All of it would pass
/// with every rect zeroed, so it belongs here rather than in
/// `Splitter.browser.test.tsx` — which takes the measurements, and only those.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

import { Splitter, type SplitterProps } from "./Splitter";

const BOUNDS = { value: 200, min: 120, max: 360, defaultValue: 240 };

function mount(props: Partial<SplitterProps> = {}) {
  const onResize = vi.fn();
  render(() => (
    <Splitter side="end" label="Git sidebar width" onResize={onResize} {...BOUNDS} {...props} />
  ));
  return { onResize, handle: screen.getByRole("separator") };
}

describe("what it announces", () => {
  /// "Git sidebar width", not "separator". A control whose accessible name is
  /// its role tells a screen-reader user nothing about which pane moves.
  it("names the pane it resizes, and where in its range it is", () => {
    const { handle } = mount();
    expect(handle).toHaveAccessibleName("Git sidebar width");
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    expect(handle).toHaveAttribute("aria-valuemin", "120");
    expect(handle).toHaveAttribute("aria-valuemax", "360");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("calls itself horizontal on the y axis", () => {
    const { handle } = mount({ axis: "y" });
    expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  });

  /// The `title` is the only place the keyboard affordance is documented — an
  /// affordance nobody knows about is not an affordance.
  it("says in its tooltip that it takes arrows and a double-click", () => {
    const { handle } = mount();
    expect(handle.getAttribute("title")).toMatch(/arrow keys/i);
    expect(handle.getAttribute("title")).toMatch(/double-click to reset/i);
  });

  /// §7.6 forbids a silent disabled control: the reason replaces the tooltip
  /// and the handle leaves the tab order rather than being a focus stop that
  /// does nothing.
  it("states why it is disabled, and stops being focusable", () => {
    const { handle } = mount({ disabledReason: "The git panel is collapsed" });
    expect(handle).toHaveAttribute("title", "The git panel is collapsed");
    expect(handle).toHaveAttribute("aria-disabled", "true");
    expect(handle).toHaveAttribute("tabindex", "-1");
  });
});

describe("resizing from the keyboard", () => {
  /// `end`-edge handles grow the pane as the pointer moves in the positive
  /// direction; the arrows have to agree with that or the keyboard and the
  /// mouse disagree about which way is bigger.
  it("steps 8px with an arrow and 32px with Shift", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount();
    handle.focus();

    await user.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(208);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onResize).toHaveBeenLastCalledWith(232);
    await user.keyboard("{ArrowLeft}");
    expect(onResize).toHaveBeenLastCalledWith(192);
  });

  /// The git sidebar sits on the right of the window, so its handle is on its
  /// `start` edge and every direction inverts. Getting this wrong makes one of
  /// the three sidebars shrink when you press the key that grows the others.
  it("inverts for a handle on the pane's start edge", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount({ side: "start" });
    handle.focus();

    await user.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(192);
  });

  it("uses the vertical arrows on the y axis", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount({ axis: "y" });
    handle.focus();

    await user.keyboard("{ArrowDown}");
    expect(onResize).toHaveBeenLastCalledWith(208);
    // The horizontal arrows are not its axis and must not move it.
    onResize.mockClear();
    await user.keyboard("{ArrowRight}");
    expect(onResize).not.toHaveBeenCalled();
  });

  it("reaches the bounds with Home and End", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount();
    handle.focus();

    await user.keyboard("{Home}");
    expect(onResize).toHaveBeenLastCalledWith(120);
    await user.keyboard("{End}");
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  /// Clamping is the property that makes holding a key safe. Stepping from
  /// 356 by 8 asks for 364; the pane settles at its max rather than growing
  /// past it and leaving the caller to notice.
  it("clamps rather than reporting a value outside the range", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount({ value: 356 });
    handle.focus();

    await user.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it("ignores every key that is not its own", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount();
    handle.focus();

    await user.keyboard("{Escape}{Tab}x");
    expect(onResize).not.toHaveBeenCalled();
  });

  it("does nothing at all while disabled", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount({ disabledReason: "collapsed" });

    // Not focusable, so the key has to be sent at the element directly — which
    // is also the honest test of the guard rather than of the tab order.
    await user.click(handle);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe("reset", () => {
  it("puts the pane back to its default on a double-click", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount();
    await user.dblClick(handle);
    expect(onResize).toHaveBeenCalledWith(240);
  });

  it("refuses to reset a disabled splitter", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount({ disabledReason: "collapsed" });
    await user.dblClick(handle);
    expect(onResize).not.toHaveBeenCalled();
  });

  /// `Enter` is the keyboard's reset — the same destination as the
  /// double-click, so the affordance is not pointer-only.
  it("resets from the keyboard too", async () => {
    const user = userEvent.setup();
    const { onResize, handle } = mount();
    handle.focus();
    await user.keyboard("{Enter}");
    expect(onResize).toHaveBeenLastCalledWith(240);
  });
});
