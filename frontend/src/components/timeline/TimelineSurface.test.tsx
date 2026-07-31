/// The timeline, actually mounted.
///
/// The first render test in this codebase, so it is worth saying what it is
/// for that `timelineModel.test.ts` is not. The model tests prove the grouping
/// and filtering are right. These prove the component is *wired* to them: that
/// it queries, that it renders `summary`, that a live event appends without
/// blanking the list, and that an unknown event kind still shows up. Those are
/// integration facts, and every one of them is a thing that has silently broken
/// in this app before.
///
/// Everything below crosses the real boundary: `@/api/journal` and
/// `@/store/journal` run unmocked, and only `invoke` is faked. That is
/// deliberate — the previous version of this file replaced `journalApi.query`,
/// which meant it could not have noticed the transport sending the wrong
/// argument name, and it had to hand-fake `onJournalAppended` rather than
/// exercise the subscribe/unsubscribe path that actually ships.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import {
  emitTauriEvent,
  lastInvokeArgs,
  mockTauri,
  tauriCalls,
  tauriListenerCount,
} from "@/test/tauri";
import { JOURNAL_APPENDED_EVENT, type JournalEvent } from "@/api/journal";

import { TimelineSurface } from "./TimelineSurface";

/// What `journal_query` answers with. Set per test.
let stored: JournalEvent[] = [];

/// Push a batch as Rust's broadcast would, through the same event name the
/// backend emits.
///
/// Waits for the subscription first, and that wait is load-bearing rather than
/// defensive: `onJournalAppended` attaches through two awaits (the dynamic
/// import, then `listen`), so a component that has already painted its first
/// query may still not be listening. The old hand-rolled mock captured the
/// handler synchronously and so could never have surfaced that ordering — which
/// is exactly the class of bug this seam exists to expose.
async function broadcast(events: JournalEvent[]): Promise<void> {
  await waitFor(() => expect(tauriListenerCount(JOURNAL_APPENDED_EVENT)).toBe(1));
  emitTauriEvent(JOURNAL_APPENDED_EVENT, events);
}

/// How many times the component actually queried Rust.
const queries = () => tauriCalls("journal_query");

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
  stored = [];
  mockTauri({
    // A function, not a value, so a test can seed `stored` after this runs.
    journal_query: () => stored,
    journal_append: [],
  });
});

describe("mounting", () => {
  it("queries the repository it was given", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    await waitFor(() => expect(queries().length).toBeGreaterThan(0));
    expect(lastInvokeArgs("journal_query")?.query).toMatchObject({ repo: REPO });
  });

  /// A repo-less worktree must not query for `undefined` and must not throw.
  it("does not query without a repository", async () => {
    render(() => <TimelineSurface repoPath="" />);
    await waitFor(() =>
      expect(screen.getByText(/nothing recorded here yet/i)).toBeInTheDocument(),
    );
    expect(queries()).toHaveLength(0);
  });

  it("says the log is empty rather than showing a bare pane", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText(/nothing recorded here yet/i)).toBeInTheDocument();
  });
});

describe("rendering events", () => {
  it("shows each event's summary", async () => {
    stored = [
      event({ id: "a", summary: "Committed “Extract the parser”" }),
      event({ id: "b", summary: "Refactorer answered “tidy this up” (4.2s)" }),
    ];
    render(() => <TimelineSurface repoPath={REPO} />);

    expect(await screen.findByText(/Extract the parser/)).toBeInTheDocument();
    expect(screen.getByText(/tidy this up/)).toBeInTheDocument();
  });

  /// The forward-compatibility contract, as a test. A kind this build has never
  /// heard of has to render — that is the entire reason `kind` is an open
  /// string and `summary` is mandatory. If somebody later adds a `switch` on
  /// `kind` with no default, this fails.
  it("renders an event kind it has never seen", async () => {
    stored = [
      event({ id: "future", kind: "hill.position.moved", summary: "Moved uphill on Search" }),
    ];
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText("Moved uphill on Search")).toBeInTheDocument();
  });

  /// Rust marks agent credit as a guess; the UI has to pass that on, or a
  /// reader will eventually act on an inference as an observation.
  it("marks inferred attribution and leaves observed events unmarked", async () => {
    stored = [
      event({
        id: "guessed",
        actor: "agent",
        actorName: "Refactorer",
        summary: "Committed “Extract the parser”",
        data: { attribution: "inferred" },
      }),
    ];
    render(() => <TimelineSurface repoPath={REPO} />);
    expect(await screen.findByText("inferred")).toBeInTheDocument();
    expect(screen.getByText("Refactorer")).toBeInTheDocument();
  });

  it("does not mark an event with no attribution claim", async () => {
    stored = [event({ id: "plain", summary: "Committed “Something”" })];
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText(/Something/);
    expect(screen.queryByText("inferred")).not.toBeInTheDocument();
  });

  it("groups under a day heading", async () => {
    stored = [event({ id: "a", summary: "Today's work" })];
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
    stored = [event({ id: "first", summary: "The first thing" })];
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("The first thing");

    await broadcast([event({ id: "second", summary: "The second thing" })]);

    await waitFor(() => expect(screen.getByText("The second thing")).toBeInTheDocument());
    expect(screen.getByText("The first thing")).toBeInTheDocument();
    expect(queries()).toHaveLength(1);
  });

  /// The broadcast goes to every window and carries every repository.
  it("ignores events from another repository", async () => {
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText(/nothing recorded here yet/i);

    await broadcast([event({ id: "elsewhere", repo: "/repos/other", summary: "Not mine" })]);

    await waitFor(() => expect(screen.queryByText("Not mine")).not.toBeInTheDocument());
  });

  /// The initial query and the broadcast race, and both can carry the event
  /// that landed in between. Showing it twice reads as two commits.
  it("does not show an event twice when the query and the broadcast overlap", async () => {
    stored = [event({ id: "same", summary: "One commit" })];
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("One commit");

    await broadcast([event({ id: "same", summary: "One commit" })]);

    await waitFor(() => expect(screen.getAllByText("One commit")).toHaveLength(1));
  });

  /// Asserted against the real listener registry rather than a fake
  /// unsubscribe: `onJournalAppended` attaches asynchronously and returns a
  /// synchronous disposer, so "did it detach" and "did it detach even though
  /// the attach had not resolved yet" are different questions and only the
  /// registry can answer the second.
  it("releases its subscription on unmount", async () => {
    const { unmount } = render(() => <TimelineSurface repoPath={REPO} />);
    await waitFor(() => expect(tauriListenerCount(JOURNAL_APPENDED_EVENT)).toBe(1));
    unmount();
    await waitFor(() => expect(tauriListenerCount(JOURNAL_APPENDED_EVENT)).toBe(0));
  });
});

describe("filtering", () => {
  const seeded = [
    event({ id: "agent", actor: "agent", actorName: "Refactorer", summary: "Agent did a thing" }),
    event({ id: "mine", actor: "user", summary: "npm finished" }),
  ];

  it("narrows to one actor and back", async () => {
    const user = userEvent.setup();
    stored = seeded;
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
    stored = seeded;
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("Agent did a thing");

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });

  it("filters by text against the summary", async () => {
    const user = userEvent.setup();
    stored = seeded;
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
    stored = seeded;
    render(() => <TimelineSurface repoPath={REPO} />);
    await screen.findByText("npm finished");

    await user.type(screen.getByRole("searchbox", { name: /filter events/i }), "zzzz");
    expect(screen.getByText(/no events match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing recorded here yet/i)).not.toBeInTheDocument();
  });
});
