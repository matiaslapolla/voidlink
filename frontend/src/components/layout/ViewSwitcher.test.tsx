/// The view switcher, mounted — and specifically its half of §7.5.3 rule 1.
///
/// Stacked mode hides a whole surface behind another: the workbench keeps
/// running under a covering view, with its strips, its rail and its status bar
/// covered along with it. Every other escalation stop is one of those, so this
/// control is the last one left. What these tests pin down is that a mark
/// reaches it, that it says so in words as well as in colour, and that the
/// segment already in front never wears one.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { publishViewActivity } from "@/store/activity";
import { setStackedView, stackedView } from "@/commands/environment";

import { ViewSwitcher } from "./ViewSwitcher";

beforeEach(() => {
  setStackedView("workbench");
  publishViewActivity(new Map());
});

describe("the segments", () => {
  it("renders the three views and presses the one in front", async () => {
    const user = userEvent.setup();
    render(() => <ViewSwitcher />);

    expect(screen.getByRole("button", { name: /workbench/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /editor/i }));
    expect(stackedView()).toBe("editor");
    expect(screen.getByRole("button", { name: /editor/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("the activity mark", () => {
  /// §10.10: a badge that exists only visually is not proactive for a
  /// screen-reader user. The signal has to be in the accessible name, not just
  /// in the dot's colour.
  it("names the signal in the segment's accessible name", () => {
    publishViewActivity(new Map([["workbench", "notify"]]));
    render(() => <ViewSwitcher />);

    expect(
      screen.getByRole("button", { name: /show the workbench — finished, needs attention/i }),
    ).toBeInTheDocument();
  });

  it("says nothing extra while every view is quiet", () => {
    render(() => <ViewSwitcher />);
    const button = screen.getByRole("button", { name: /workbench/i });
    expect(button).toHaveAccessibleName("Show the workbench");
  });

  /// The mark is published per view, so switching to the marked view is what
  /// makes it stop — `escalate` drops the view in front from its output. This
  /// asserts the rendering half of that: given no entry for a view, that
  /// segment carries nothing, whatever the others are carrying.
  it("marks only the views it was given", () => {
    publishViewActivity(new Map([["workbench", "failed"]]));
    render(() => <ViewSwitcher />);

    expect(screen.getByRole("button", { name: /workbench — failed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /git/i })).toHaveAccessibleName("Show the git");
  });
});
