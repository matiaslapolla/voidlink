/// The brain overlay, mounted.
///
/// Cut C2 moved this surface off the tab strip. The move is only correct if
/// nothing it could do as a tab was lost, so the first three tests are the three
/// capabilities — search, read, capture — exercised through the overlay chrome.
/// The rest guard the two things a tab never had to get right: dismissal, and
/// telling the browser webview to get out of the way.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { isOverlayOpen } from "@/commands/overlay";
import { stubLayout } from "@/test/layout";

import { BrainOverlay, BrainOverlayHost } from "./BrainOverlay";

const REPO = "/repo";

const ENTRIES = [
  {
    id: "2026-01-01-pricing",
    path: "decisions/2026-01-01-pricing.md",
    title: "Pricing for the beta",
    entryType: "decision",
    labels: ["pricing"],
    project: "voidlink",
    created: "2026-01-01",
  },
  {
    id: "2026-02-02-latency",
    path: "notes/2026-02-02-latency.md",
    title: "Latency notes",
    entryType: "note",
    labels: ["perf"],
    project: null,
    created: "2026-02-02",
  },
];

beforeEach(() => {
  mockTauri({
    brain_list_entries: ENTRIES,
    brain_read_entry: (args: Record<string, unknown>) => ({
      ...ENTRIES.find((e) => e.path === args.relPath),
      body: "The body of the entry.",
    }),
    brain_save_entry: ".voidlink/brain/notes/2026-03-03-new.md",
  });
});

const onClose = vi.fn(() => {});

function mount() {
  onClose.mockClear();
  return render(() => <BrainOverlay repoPath={REPO} onClose={onClose} />);
}

/// The entry list is virtualized, and a virtualizer told the viewport is 0px
/// tall renders zero rows. See `@/test/layout` for why this is opt-in.
describe("the three capabilities the tab had", () => {
  stubLayout();


  it("lists the vault's entries", async () => {
    mount();
    expect(await screen.findByText("Pricing for the beta")).toBeInTheDocument();
    expect(screen.getByText("Latency notes")).toBeInTheDocument();
  });

  it("searches", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Pricing for the beta");

    await user.type(screen.getByPlaceholderText(/search entries/i), "latency");

    await waitFor(() => expect(screen.queryByText("Pricing for the beta")).not.toBeInTheDocument());
    expect(screen.getByText("Latency notes")).toBeInTheDocument();
  });

  /// The capability a `QuickPick` could not have carried. If picking a row only
  /// closed the overlay, the move would have cost the reading pane.
  it("reads a picked entry in place, rendered", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByText("Pricing for the beta"));

    expect(await screen.findByText("The body of the entry.")).toBeInTheDocument();
    // Still open: reading happens *in* the overlay, it is not a hand-off.
    expect(onClose).not.toHaveBeenCalled();
  });

  /// The other capability a popover list could not have carried.
  it("captures a quick note", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Pricing for the beta");

    await user.click(screen.getByRole("button", { name: /quick note/i }));
    await user.type(screen.getByPlaceholderText("Title"), "A new thought");
    await user.type(screen.getByPlaceholderText(/labels, comma-separated/i), "perf");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByPlaceholderText(/search entries/i)).toBeInTheDocument());
  });
});

describe("dismissal", () => {
  it("closes on ESC, from inside the search field", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByPlaceholderText(/search entries/i));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the scrim and on the button, but not on the panel", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close Brain" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/// A child webview composites above the DOM, so an overlay that does not
/// register here is simply invisible whenever a browser tab is open. The
/// unmount half matters as much as the mount half: leaking the registration
/// leaves the browser pane hidden with nothing on screen to explain why.
describe("the overlay registration", () => {
  it("registers while open and releases on unmount", () => {
    const { unmount } = mount();
    expect(isOverlayOpen()).toBe(true);
    unmount();
    expect(isOverlayOpen()).toBe(false);
  });

  it("registers nothing while the host is closed", () => {
    render(() => <BrainOverlayHost open={false} repoPath={REPO} onClose={onClose} />);
    expect(isOverlayOpen()).toBe(false);
  });
});

/// A brain is scoped to a repository, so a workspace that is only a folder has
/// nothing to list. §7.6 wants the empty state to name the fix rather than
/// render an empty pane — and the fix is now "open a repo", not "set a path".
describe("no repository open", () => {
  it("says what would fix it", () => {
    render(() => <BrainOverlay repoPath="" onClose={onClose} />);
    expect(screen.getByText(/open a repository/i)).toBeInTheDocument();
  });
});

/// Capture writes into the repository you are working in, so the argument that
/// decides *where* is the one worth pinning down. The absent `message` is the
/// other half: this used to commit what it wrote, and a project brain that
/// commits lands on the branch you are mid-change on.
describe("what capture sends across the boundary", () => {
  it("scopes the write to the open repo, and asks for no commit", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Pricing for the beta");

    await user.click(screen.getByRole("button", { name: /quick note/i }));
    await user.type(screen.getByPlaceholderText("Title"), "A new thought");
    await user.type(screen.getByPlaceholderText(/labels, comma-separated/i), "perf");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(tauriCalls("brain_save_entry")).toHaveLength(1));
    const args = lastInvokeArgs("brain_save_entry")!;
    expect(args.repoRoot).toBe(REPO);
    expect(args.relPath).toMatch(/^notes\/\d{4}-\d{2}-\d{2}-a-new-thought\.md$/);
    expect(args).not.toHaveProperty("message");
  });

  it("lists and reads against the same repo root", async () => {
    const user = userEvent.setup();
    mount();
    expect(lastInvokeArgs("brain_list_entries")!.repoRoot).toBe(REPO);

    await user.click(await screen.findByText("Pricing for the beta"));
    await waitFor(() => expect(tauriCalls("brain_read_entry")).toHaveLength(1));
    expect(lastInvokeArgs("brain_read_entry")!.repoRoot).toBe(REPO);
  });
});
