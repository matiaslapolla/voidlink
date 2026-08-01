/// The hills, mounted.
///
/// The maths is proven in `hillModel.test.ts` and the store's recording
/// contract in `store/hills.test.ts`. What is left — and what only a mounted
/// test can reach — is that the dot is *operable*: a hill you can only move by
/// dragging is a hill a keyboard user cannot move, and "cannot record progress"
/// is a worse failure than a chart that looks wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { HillScope } from "./hillModel";

let scopes: HillScope[] = [];
const addHillScope = vi.fn();
const moveHillScope = vi.fn();
const removeHillScope = vi.fn();
const setHillScopeDone = vi.fn();

vi.mock("@/store/hills", () => ({
  hillScopes: () => scopes,
  addHillScope: (o: unknown) => addHillScope(o),
  moveHillScope: (o: unknown) => moveHillScope(o),
  removeHillScope: (o: unknown) => removeHillScope(o),
  setHillScopeDone: (o: unknown) => setHillScopeDone(o),
}));

import { HillsSection } from "./HillsSection";

function scope(partial: Partial<HillScope> = {}): HillScope {
  return {
    id: "s1",
    workspaceId: "ws",
    name: "Search",
    position: 0.2,
    updatedAt: Date.now(),
    done: false,
    ...partial,
  };
}

beforeEach(() => {
  scopes = [];
  addHillScope.mockReset().mockReturnValue("new-id");
  moveHillScope.mockReset();
  removeHillScope.mockReset();
  setHillScopeDone.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("the empty state", () => {
  /// The empty state has to teach what a scope *is*, because the concept is
  /// the whole feature and nothing else in this app introduces it.
  it("explains what a scope is rather than showing a bare pane", () => {
    render(() => <HillsSection workspaceId="ws" />);
    expect(screen.getByText(/still figuring out or already executing/i)).toBeInTheDocument();
  });
});

describe("adding a scope", () => {
  it("submits the typed name and clears the field", async () => {
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" repoPath="/api" />);

    const field = screen.getByRole("textbox", { name: /new scope/i });
    await user.type(field, "Search{Enter}");

    expect(addHillScope).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws", name: "Search", repo: "/api" }),
    );
    expect(field).toHaveValue("");
  });

  /// The store refuses a blank name by returning null; the field must then keep
  /// what the user typed rather than silently clearing it.
  it("keeps the field when the store refused the name", async () => {
    addHillScope.mockReturnValue(null);
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);

    const field = screen.getByRole("textbox", { name: /new scope/i });
    await user.type(field, "   {Enter}");
    expect(field).toHaveValue("   ");
  });
});

describe("the dot", () => {
  it("is a slider carrying its position and its phase", () => {
    scopes = [scope({ position: 0.8 })];
    render(() => <HillsSection workspaceId="ws" />);

    const dot = screen.getByRole("slider", { name: /Search position/i });
    expect(dot).toHaveAttribute("aria-valuenow", "80");
    expect(dot).toHaveAttribute("aria-valuetext", "Making it happen");
  });

  /// The accessibility requirement and the trackpad requirement are the same
  /// requirement.
  it("moves on the arrow keys", async () => {
    scopes = [scope({ position: 0.2 })];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" repoPath="/api" />);

    screen.getByRole("slider", { name: /Search position/i }).focus();
    await user.keyboard("{ArrowRight}");

    expect(moveHillScope).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "s1", position: expect.closeTo(0.25, 5) }),
    );
  });

  it("moves back on the left arrow", async () => {
    scopes = [scope({ position: 0.5 })];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);

    screen.getByRole("slider", { name: /Search position/i }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(moveHillScope.mock.calls[0][0]).toMatchObject({
      position: expect.closeTo(0.45, 5),
    });
  });

  it("jumps to either end on Home and End", async () => {
    scopes = [scope({ position: 0.5 })];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);

    const dot = screen.getByRole("slider", { name: /Search position/i });
    dot.focus();
    await user.keyboard("{End}");
    await user.keyboard("{Home}");
    // Both go through the store, which clamps — the component deliberately does
    // not pre-clamp, so there is exactly one place that decides what is on the
    // hill.
    expect(moveHillScope.mock.calls.map((c) => c[0].position)).toEqual([1.5, -0.5]);
  });

  /// A key that is not a movement must not be swallowed — the pane's own
  /// shortcuts still have to work while the dot has focus.
  it("ignores keys that are not movement", async () => {
    scopes = [scope()];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);

    screen.getByRole("slider", { name: /Search position/i }).focus();
    await user.keyboard("k");
    expect(moveHillScope).not.toHaveBeenCalled();
  });
});

describe("the row", () => {
  /// The axis carries the same two words as decoration, so this ignores the
  /// hidden subtree — which is also the assertion that the axis stayed
  /// decorative and did not start being announced twice per scope.
  it("names the phase in words", () => {
    scopes = [scope({ position: 0.1 })];
    render(() => <HillsSection workspaceId="ws" />);
    expect(
      screen.getByText("Figuring it out", {
        // The axis labels are *inside* an `aria-hidden` container rather than
        // hidden themselves, so the descendant selector is the one that
        // matches them.
        ignore: "script, style, [aria-hidden='true'], [aria-hidden='true'] *",
      }),
    ).toBeInTheDocument();
  });

  /// A scope nobody has moved in days is the signal the chart exists to
  /// produce. It has to be visible without opening anything.
  it("marks a scope that has not moved in days", () => {
    scopes = [scope({ updatedAt: Date.now() - 5 * 86_400_000 })];
    render(() => <HillsSection workspaceId="ws" />);
    expect(screen.getByText("5d still")).toBeInTheDocument();
  });

  it("does not call a finished scope stalled", () => {
    scopes = [scope({ updatedAt: Date.now() - 5 * 86_400_000, done: true })];
    render(() => <HillsSection workspaceId="ws" />);
    expect(screen.queryByText("5d still")).not.toBeInTheDocument();
  });

  it("finishes and reopens through the same control", async () => {
    scopes = [scope()];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);

    await user.click(screen.getByRole("button", { name: "Finish Search" }));
    expect(setHillScopeDone).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "s1", done: true }),
    );

    scopes = [scope({ done: true })];
    const again = render(() => <HillsSection workspaceId="ws" />);
    expect(
      again.getByRole("button", { name: "Reopen Search" }),
    ).toBeInTheDocument();
  });

  it("stops tracking on request", async () => {
    scopes = [scope()];
    const user = userEvent.setup();
    render(() => <HillsSection workspaceId="ws" />);
    await user.click(screen.getByRole("button", { name: "Stop tracking Search" }));
    expect(removeHillScope).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "s1" }),
    );
  });

  it("sorts what is still being figured out above what is being executed", () => {
    scopes = [
      scope({ id: "down", name: "Downhill", position: 0.9 }),
      scope({ id: "up", name: "Uphill", position: 0.1 }),
    ];
    render(() => <HillsSection workspaceId="ws" />);
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(["Uphill", "Downhill"]);
  });
});
