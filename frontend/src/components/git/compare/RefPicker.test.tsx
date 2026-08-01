/// The compare tab's ref picker, mounted.
///
/// From the 2026-07-30 audit: CMP-F15 (a detached HEAD unreachable from the
/// picker), CMP-F19 (branch names that look like SHAs), CMP-F20 (the first
/// ArrowDown skipping item 0, and the arrows doing nothing at all on a closed
/// picker), CMP-F21 (Escape reaching whatever is behind the dropdown) and
/// CMP-F22 (the existing value not editable). Every one of them shipped
/// without the component ever being mounted.
///
/// No Tauri stub needed: the picker is a pure function of its props — the
/// fetching lives in `CompareTab`.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { RefList } from "@/types/git";

import { RefPicker } from "./RefPicker";

function refList(partial: Partial<RefList> = {}): RefList {
  return {
    branches: ["main", "feature/x"],
    tags: [],
    recentCommits: [],
    detachedHead: null,
    ...partial,
  };
}

function mount(overrides: Partial<Parameters<typeof RefPicker>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(() => (
    <RefPicker label="Base" value="main" refs={refList()} onChange={onChange} {...overrides} />
  ));
  return { ...result, onChange };
}

/// The dot is the only thing on screen that says what kind of ref the picker
/// thinks it is holding, so it is what the classification tests read.
function dotClasses(container: HTMLElement): string {
  const dot = container.querySelector('button[aria-haspopup="listbox"] > span');
  return dot?.className ?? "";
}

describe("classifying the current value", () => {
  it("calls a branch a branch", () => {
    const { container } = mount({ value: "main" });
    expect(dotClasses(container)).toContain("bg-primary");
  });

  /// CMP-F19. `deadbeef`, `accede`, `facade` and `beaded` are all legal branch
  /// names that match `/^[0-9a-f]{7,40}$/`.
  it("does not call a branch a commit because its name is a hex word", () => {
    const { container } = mount({
      value: "deadbeef",
      refs: refList({ branches: ["main", "deadbeef"] }),
    });
    expect(dotClasses(container)).toContain("bg-primary");
  });

  /// The half that was actually wrong on screen: the heuristic ran before the
  /// ref list arrived, so a branch named after a hex word opened as a commit
  /// and changed kind under the user a moment later. Claim nothing until
  /// there is something to check against.
  it("claims nothing while the ref list is still loading", () => {
    const { container } = mount({ value: "deadbeef", refs: null, loading: true });
    expect(dotClasses(container)).not.toContain("bg-info");
    expect(dotClasses(container)).toContain("bg-muted-foreground");
  });

  it("still calls a real sha a commit once the list has arrived", () => {
    const { container } = mount({ value: "deadbeef", refs: refList() });
    expect(dotClasses(container)).toContain("bg-info");
  });
});

/// CMP-F15. A detached HEAD is named by no ref the repository lists, so
/// mid-bisect or after checking out a tag the position the user is standing on
/// was the one thing this picker could not offer.
describe("a detached HEAD", () => {
  it("is offered, with the commit it is sitting on", async () => {
    const user = userEvent.setup();
    mount({
      refs: refList({
        detachedHead: {
          oid: "abc1234def",
          shortOid: "abc1234",
          summary: "bisecting",
          time: Math.floor(Date.now() / 1000),
        },
      }),
    });

    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("HEAD")).toBeInTheDocument();
    expect(screen.getByText(/detached at abc1234/)).toBeInTheDocument();
  });

  /// `HEAD` rather than the oid, because that is the name that keeps meaning
  /// "here" as the bisect moves.
  it("is committed as the name HEAD, not as a sha", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({
      refs: refList({
        detachedHead: {
          oid: "abc1234def",
          shortOid: "abc1234",
          summary: "bisecting",
          time: Math.floor(Date.now() / 1000),
        },
      }),
    });

    await user.click(screen.getByRole("button", { expanded: false }));
    await user.click(screen.getByText("HEAD"));
    expect(onChange).toHaveBeenCalledWith("HEAD");
  });

  it("is absent when HEAD is on a branch", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByText("HEAD")).not.toBeInTheDocument();
  });
});

describe("keyboard", () => {
  /// CMP-F20. The picker opened with the highlight already on 0, so the first
  /// ArrowDown moved to item *1* — the top branch could only be reached by
  /// wrapping all the way round or by mouse.
  it("moves to the first item on the first ArrowDown", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({ refs: refList({ branches: ["alpha", "beta"] }) });

    await user.click(screen.getByRole("button", { expanded: false }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("alpha");
  });

  it("reaches the second item on the second ArrowDown", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({ refs: refList({ branches: ["alpha", "beta"] }) });

    await user.click(screen.getByRole("button", { expanded: false }));
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  /// ArrowUp goes all the way back out of the list, or the first item is a
  /// trap and Enter can no longer commit what was typed.
  it("commits the typed text when nothing is highlighted", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({ refs: refList({ branches: ["alpha"] }) });

    await user.click(screen.getByRole("button", { expanded: false }));
    await user.clear(screen.getByRole("textbox", { name: /search refs/i }));
    await user.keyboard("HEAD~3{ArrowDown}{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith("HEAD~3");
  });

  /// CMP-F20's other half: the arrows only ever reached the search input,
  /// which does not exist until the picker is open.
  it("opens on ArrowDown from the closed button", async () => {
    const user = userEvent.setup();
    mount();
    const button = screen.getByRole("button", { expanded: false });
    button.focus();
    await user.keyboard("{ArrowDown}");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  /// CMP-F21. Escape closed the dropdown and then went on to whatever is
  /// behind it — the tab the user was mid-edit in.
  it("does not let Escape through to whatever is behind the dropdown", async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    render(() => (
      <div onKeyDown={behind}>
        <RefPicker label="Base" value="main" refs={refList()} onChange={() => {}} />
      </div>
    ));

    const button = screen.getByRole("button", { expanded: false });
    await user.click(button);
    behind.mockClear();
    await user.keyboard("{Escape}");

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(behind).not.toHaveBeenCalled();
  });
});

/// CMP-F22. Opening emptied the box, so the common edit — turning
/// `origin/main` into `origin/main~3`, or fixing one character of a long
/// branch name — meant retyping the whole thing from nothing.
describe("editing the existing value", () => {
  it("opens with the current ref already in the box", async () => {
    const user = userEvent.setup();
    mount({ value: "origin/main" });
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("textbox", { name: /search refs/i })).toHaveValue("origin/main");
  });

  it("lets the user extend it into a revision expression", async () => {
    const user = userEvent.setup();
    const { onChange } = mount({ value: "origin/main" });
    await user.click(screen.getByRole("button", { expanded: false }));

    const input = screen.getByRole("textbox", { name: /search refs/i }) as HTMLInputElement;
    // Undo the select-all the open performs, so typing appends rather than
    // replaces — the same thing pressing End does.
    input.setSelectionRange(input.value.length, input.value.length);
    await user.keyboard("~3{Enter}");
    expect(onChange).toHaveBeenCalledWith("origin/main~3");
  });
});
