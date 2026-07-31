/// Mission Control, mounted.
///
/// The models are tested in the `unit` project; these prove the surface is
/// *wired* to them — that each section queries what it claims to, that live
/// events reach the lineup without a refetch, and that the three sections do
/// not all mount at once. Every one of those is an integration fact no pure
/// test can reach.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { ActiveAgent, JournalEvent, RepoIdentity } from "@/api/journal";

const query = vi.fn();
const repos = vi.fn();
const activeAgents = vi.fn();
let broadcast: ((events: JournalEvent[]) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock("@/api/journal", () => ({
  JOURNAL_APPENDED_EVENT: "voidlink://journal-appended",
  journalApi: {
    query: (q: unknown) => query(q),
    repos: () => repos(),
    activeAgents: () => activeAgents(),
    append: vi.fn(),
  },
}));

vi.mock("@/store/journal", () => ({
  onJournalAppended: (handler: (events: JournalEvent[]) => void) => {
    broadcast = handler;
    return unsubscribe;
  },
  record: vi.fn(),
}));

import { MissionSurface } from "./MissionSurface";

function identity(path: string, workspace: string, isMain = false): RepoIdentity {
  return {
    path,
    workspaceId: `ws-${workspace}`,
    workspaceName: workspace,
    worktreeId: `wt${path}`,
    isMain,
  };
}

function event(partial: Partial<JournalEvent> & { id: string }): JournalEvent {
  return {
    at: Date.now(),
    kind: "git.commit",
    actor: "system",
    actorName: null,
    repo: "/api",
    workspace: "api",
    subject: null,
    summary: "something happened",
    data: {},
    ...partial,
  };
}

function agent(repo: string, name: string): ActiveAgent {
  return { repo, name, since: Date.now() - 60_000 };
}

beforeEach(() => {
  broadcast = null;
  unsubscribe.mockReset();
  query.mockReset().mockResolvedValue([]);
  repos.mockReset().mockResolvedValue([]);
  activeAgents.mockReset().mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("the shell", () => {
  it("opens on the lineup", async () => {
    render(() => <MissionSurface workspaceId="ws-api" />);
    expect(screen.getByRole("button", { name: "Lineup" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(repos).toHaveBeenCalled());
  });

  /// Three live subscriptions where the user can read one is the kind of cost
  /// nobody notices until they profile it.
  it("mounts only the section being read", async () => {
    const user = userEvent.setup();
    render(() => <MissionSurface workspaceId="ws-api" />);
    await waitFor(() => expect(repos).toHaveBeenCalled());
    const lineupCalls = query.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Check-in" }));
    // The lineup's subscription is released the moment it unmounts.
    expect(unsubscribe).toHaveBeenCalled();
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(lineupCalls));
  });

  it("reports the selected section to assistive technology", async () => {
    const user = userEvent.setup();
    render(() => <MissionSurface workspaceId="ws-api" />);
    await user.click(screen.getByRole("button", { name: "Hills" }));
    expect(screen.getByRole("button", { name: "Hills" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Lineup" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("the lineup", () => {
  it("lists every registered checkout under its workspace", async () => {
    repos.mockResolvedValue([
      identity("/api", "api", true),
      identity("/api-hotfix", "api"),
      identity("/site", "site", true),
    ]);
    render(() => <MissionSurface workspaceId="ws-api" />);

    // By role, because a workspace and its main checkout legitimately share a
    // name — "site" is both a heading and a row, and a bare text query would
    // pass or fail on which one the DOM happened to reach first.
    expect(await screen.findByRole("heading", { name: "api" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "site" })).toBeInTheDocument();
    const rows = await screen.findAllByRole("button", { name: /api|site/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("api"),
      expect.stringContaining("api-hotfix"),
      expect.stringContaining("site"),
    ]);
  });

  /// A checkout with no history still exists. A missing row reads as a missing
  /// worktree.
  it("shows a checkout with an empty log rather than omitting it", async () => {
    repos.mockResolvedValue([identity("/api", "api", true)]);
    render(() => <MissionSurface workspaceId="ws-api" />);
    expect(await screen.findByText("Nothing recorded")).toBeInTheDocument();
  });

  it("says so when no workspace is registered at all", async () => {
    render(() => <MissionSurface workspaceId="ws-api" />);
    expect(await screen.findByText(/no workspaces are registered/i)).toBeInTheDocument();
  });

  /// Live state, not the log — turns are recorded on their end, so there is no
  /// "started" event and the running agent has to come from Rust's registry.
  it("reports a running agent ahead of the last recorded event", async () => {
    repos.mockResolvedValue([identity("/api", "api", true)]);
    query.mockResolvedValue([event({ id: "c", summary: "Committed “x”" })]);
    activeAgents.mockResolvedValue([agent("/api", "Refactorer")]);
    render(() => <MissionSurface workspaceId="ws-api" />);

    expect(await screen.findByText(/Refactorer working/)).toBeInTheDocument();
    expect(screen.queryByText(/Committed “x”/)).not.toBeInTheDocument();
  });

  /// MASTER §7.5.2: never blank a rendered region to show it is updating.
  it("appends a broadcast event without re-querying", async () => {
    repos.mockResolvedValue([identity("/api", "api", true)]);
    render(() => <MissionSurface workspaceId="ws-api" />);
    await screen.findByText("Nothing recorded");
    const before = query.mock.calls.length;

    broadcast?.([event({ id: "fresh", summary: "Committed “fresh”" })]);

    await waitFor(() => expect(screen.getByText(/Committed “fresh”/)).toBeInTheDocument());
    expect(query.mock.calls.length).toBe(before);
  });

  it("releases its subscription on unmount", async () => {
    const { unmount } = render(() => <MissionSurface workspaceId="ws-api" />);
    await waitFor(() => expect(repos).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("the check-in", () => {
  async function openCheckin() {
    const user = userEvent.setup();
    render(() => <MissionSurface workspaceId="ws-api" />);
    await user.click(screen.getByRole("button", { name: "Check-in" }));
    return user;
  }

  it("queries a bounded window rather than the whole log", async () => {
    await openCheckin();
    await waitFor(() => {
      const q = query.mock.calls.at(-1)?.[0] as { since?: number };
      expect(q?.since).toBeTypeOf("number");
    });
  });

  it("groups what happened by repository and by who did it", async () => {
    query.mockResolvedValue([
      event({
        id: "a",
        actor: "agent",
        actorName: "Refactorer",
        kind: "git.commit",
        subject: "Extract the parser",
      }),
      event({ id: "b", actor: "user", kind: "terminal.command.finished" }),
    ]);
    await openCheckin();

    expect(await screen.findByText("Refactorer")).toBeInTheDocument();
    expect(screen.getByText(/1 commit/)).toBeInTheDocument();
    // Verbatim — a check-in that paraphrased would be inventing history.
    expect(screen.getByText("“Extract the parser”")).toBeInTheDocument();
  });

  /// "Nothing happened" is an answer. A blank pane reads as a broken surface.
  it("says nothing was recorded rather than rendering an empty pane", async () => {
    await openCheckin();
    expect(await screen.findByText(/nothing was recorded in this window/i)).toBeInTheDocument();
  });

  it("re-queries when the window changes", async () => {
    const user = await openCheckin();
    await waitFor(() => expect(query).toHaveBeenCalled());
    const before = query.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(before));
  });
});
