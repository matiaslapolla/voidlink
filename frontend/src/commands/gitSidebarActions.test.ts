/// Requests for sidebar-owned git actions.
///
/// The bug this replaces was silent: with the panel collapsed the sidebar is
/// unmounted, so a `window.dispatchEvent` for "fetch" reached nobody and the
/// user was left believing they had fetched. Every test here is about the
/// no-handler case, because that is the one that used to fail quietly.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerGitSidebarActions,
  requestGitSidebarAction,
  resetGitSidebarActions,
} from "./gitSidebarActions";

afterEach(() => resetGitSidebarActions());

describe("with the sidebar mounted", () => {
  it("runs the action and reports that it was handled", () => {
    const fetch = vi.fn();
    registerGitSidebarActions({ fetch });

    expect(requestGitSidebarAction("fetch")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports unhandled for an action this registration does not offer", () => {
    registerGitSidebarActions({ fetch: vi.fn() });
    expect(requestGitSidebarAction("pull")).toBe(false);
  });
});

describe("with the sidebar unmounted", () => {
  it("reports unhandled so the caller can reveal the panel", () => {
    expect(requestGitSidebarAction("fetch")).toBe(false);
  });

  /// The whole point: revealing the panel has to *complete* the action, not
  /// merely make the next attempt work.
  it("replays the held request when the sidebar registers", () => {
    const fetch = vi.fn();
    expect(requestGitSidebarAction("fetch")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    registerGitSidebarActions({ fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds only the most recent request", () => {
    const fetch = vi.fn();
    const pull = vi.fn();
    requestGitSidebarAction("fetch");
    requestGitSidebarAction("pull");

    registerGitSidebarActions({ fetch, pull });
    // Replaying both would fetch *and* pull off one keypress.
    expect(fetch).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("replays once, not on every subsequent mount", () => {
    const fetch = vi.fn();
    requestGitSidebarAction("fetch");

    const off = registerGitSidebarActions({ fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    off();
    registerGitSidebarActions({ fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("registration lifecycle", () => {
  /// Stacked mode swaps one git view for another, and the replacement can
  /// mount before the old one cleans up. A blind reset on unregister would
  /// drop the live handlers.
  it("a stale unregister does not clear the current handlers", () => {
    const oldFetch = vi.fn();
    const newFetch = vi.fn();

    const offOld = registerGitSidebarActions({ fetch: oldFetch });
    registerGitSidebarActions({ fetch: newFetch });
    offOld();

    expect(requestGitSidebarAction("fetch")).toBe(true);
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect(oldFetch).not.toHaveBeenCalled();
  });

  it("stops handling after the current registration unregisters", () => {
    const fetch = vi.fn();
    const off = registerGitSidebarActions({ fetch });
    off();

    expect(requestGitSidebarAction("fetch")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
