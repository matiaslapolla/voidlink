/// The timeline, actually mounted.
///
/// The first render test in this codebase, so it is worth saying what it is
/// for that `timelineModel.test.ts` is not. The model tests prove the grouping
/// and filtering are right. These prove the component is *wired* to them: that
/// it queries, that it renders `summary`, that a live event appends without
/// blanking the list, and that an unknown event kind still shows up. Those are
/// integration facts, and every one of them is a thing that has silently broken
/// in this app before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { JournalEvent } from "@/api/journal";

const query = vi.fn();
/// The handler the component registers, captured so a test can push a live
/// event through exactly the path Rust's broadcast would.
let broadcast: ((events: JournalEvent[]) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock("@/api/journal", () => ({
  JOURNAL_APPENDED_EVENT: "voidlink://journal-appended",
  journalApi: { query: (q: unknown) => query(q), append: vi.fn() },
}));

vi.mock("@/store/journal", () => ({
  onJournalAppended: (handler: (events: JournalEvent[]) => void) => {
    broadcast = handler;
    return unsubscribe;
  },
}));

import { TimelineSurface } from "./TimelineSurface";

const REPO = "/repos/voidlink";

function event(partial: Partial<JournalEvent> & { id: string }): JournalEvent {
  return {
    at: Date.now(),
    kind: "git.commit",
    actor: "system",
    actorName: null,
    repo: REPO,
    workspace: null,
    subject: null,
    summary: "something happened",
    data: {},
    ...partial,
  };
}

beforeEach(() => {
  broadcast = null;
  unsubscribe.mockReset();
  query.mockReset();
  query.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("mounting", () => {
  it("queries the repository it was given", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(query.mock.calls[0][0]).toMatchObject({ repo: REPO });
  });

  /// A repo-less worktree must not query for `undefined` and must not throw.
  it("does not query without a repository", async () => {
    render(() => <TimelineSurface repoPath="" />);
    await waitFor(() =>
      expect(screen.getByText(/nothing recorded here yet/i)).toBeInTheDocument(),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("says the log is empty rather than showing a bare pane", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText(/nothing recorded here yet/i)).toBeInTheDocument();
  });
});

describe("rendering events", () => {
  it("shows each event's summary", async () => {
    query.mockResolvedValue([
      event({ id: "a", summary: "Committed “Extract the parser”" }),
      event({ id: "b", summary: "Refactorer answered “tidy this up” (4.2s)" }),
    ]);
    render(() => <TimelineSurface repoPath={REPO} />);

    expect(await screen.findByText(/Extract the parser/)).toBeInTheDocument();
    expect(screen.getByText(/tidy this up/)).toBeInTheDocument();
  });

  /// The forward-compatibility contract, as a test. A kind this build has never
  /// heard of has to render — that is the entire reason `kind` is an open
  /// string and `summary` is mandatory. If somebody later adds a `switch` on
  /// `kind` with no default, this fails.
  it("renders an event kind it has never seen", async () => {
    query.mockResolvedValue([
      event({ id: "future", kind: "hill.position.moved", summary: "Moved uphill on Search" }),
    ]);
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText("Moved uphill on Search")).toBeInTheDocument();
  });

  /// Rust marks agent credit as a guess; the UI has to pass that on, or a
  /// reader will eventually act on an inference as an observation.
  it("marks inferred attribution and leaves observed events unmarked", async () => {
    query.mockResolvedValue([
      event({
        id: "guessed",
        actor: "agent",
        actorName: "Refactorer",
        summary: "Committed “Extract the parser”",
        data: { attribution: "inferred" },
      }),
    ]);
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText("inferred")).toBeInTheDocument();
    expect(screen.getByText("Refactorer")).toBeInTheDocument();
  });

  it("does not mark an event with no attribution claim", async () => {
    query.mockResolvedValue([event({ id: "plain", summary: "Committed “Something”" })]);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText(/Something/);
    expect(screen.queryByText("inferred")).not.toBeInTheDocument();
  });

  it("groups under a day heading", async () => {
    query.mockResolvedValue([event({ id: "a", summary: "Today's work" })]);
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
  });
});

describe("live updates", () => {
  /// The load-bearing one. MASTER §7.5.2/§7.5.4: never blank a rendered region
  /// to show it is updating. An arriving event must *append*, leaving what the
  /// user is reading on screen — the commit graph gets this wrong and this
  /// surface must not copy it.
  it("appends a broadcast event without disturbing what is already shown", async () => {
    query.mockResolvedValue([event({ id: "first", summary: "The first thing" })]);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("The first thing");

    broadcast?.([event({ id: "second", summary: "The second thing" })]);

    await waitFor(() => expect(screen.getByText("The second thing")).toBeInTheDocument());
    expect(screen.getByText("The first thing")).toBeInTheDocument();
    expect(query).toHaveBeenCalledTimes(1);
  });

  /// The broadcast goes to every window and carries every repository.
  it("ignores events from another repository", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText(/nothing recorded here yet/i);

    broadcast?.([event({ id: "elsewhere", repo: "/repos/other", summary: "Not mine" })]);

    await waitFor(() => expect(screen.queryByText("Not mine")).not.toBeInTheDocument());
  });

  /// The initial query and the broadcast race, and both can carry the event
  /// that landed in between. Showing it twice reads as two commits.
  it("does not show an event twice when the query and the broadcast overlap", async () => {
    query.mockResolvedValue([event({ id: "same", summary: "One commit" })]);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("One commit");

    broadcast?.([event({ id: "same", summary: "One commit" })]);

    await waitFor(() => expect(screen.getAllByText("One commit")).toHaveLength(1));
  });

  it("releases its subscription on unmount", async () => {
    const { unmount } = render(() => <TimelineSurface repoPath={REPO} />);
    await waitFor(() => expect(query).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("filtering", () => {
  const seeded = [
    event({ id: "agent", actor: "agent", actorName: "Refactorer", summary: "Agent did a thing" }),
    event({ id: "mine", actor: "user", summary: "npm finished" }),
  ];

  it("narrows to one actor and back", async () => {
    const user = userEvent.setup();
    query.mockResolvedValue(seeded);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("Agent did a thing");

    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.queryByText("npm finished")).not.toBeInTheDocument();
    expect(screen.getByText("Agent did a thing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("npm finished")).toBeInTheDocument();
  });

  it("reports the selected filter to assistive technology", async () => {
    const user = userEvent.setup();
    query.mockResolvedValue(seeded);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("Agent did a thing");

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });

  it("filters by text against the summary", async () => {
    const user = userEvent.setup();
    query.mockResolvedValue(seeded);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("npm finished");

    await user.type(screen.getByRole("searchbox", { name: /filter events/i }), "npm");
    expect(screen.queryByText("Agent did a thing")).not.toBeInTheDocument();
    expect(screen.getByText("npm finished")).toBeInTheDocument();
  });

  /// "Nothing matched your filter" and "nothing has happened" are different
  /// facts, and a surface that conflates them sends the user looking for a bug.
  it("distinguishes an empty log from an empty filter result", async () => {
    const user = userEvent.setup();
    query.mockResolvedValue(seeded);
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("npm finished");

    await user.type(screen.getByRole("searchbox", { name: /filter events/i }), "zzzz");
    expect(screen.getByText(/no events match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing recorded here yet/i)).not.toBeInTheDocument();
  });
});
