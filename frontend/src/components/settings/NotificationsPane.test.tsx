/// The notification matrix, mounted.
///
/// The policy itself is Rust's and is tested there, in `notify/mod.rs`, as pure
/// functions. What only a mounted test can prove is the half that has burned
/// this kind of screen before: that the pane writes **through** rather than
/// keeping a copy. Two copies of one config — one in a store, one in Rust — is
/// how a settings screen ends up showing something different from what the app
/// does, and no unit test of either side can catch it.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { resetToasts, useToasts } from "@/commands/toast";
import type { NotifyConfig } from "@/api/notify";

import { NotificationsPane } from "./NotificationsPane";

function config(partial: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    muted: false,
    quietHours: null,
    rules: [
      { prefix: "agent.turn.failed", level: "both" },
      { prefix: "agent.turn.finished", level: "banner" },
    ],
    coalesceMs: 2000,
    volume: 0.6,
    pack: "default",
    ...partial,
  };
}

/// What Rust would answer with. Reassigned per test.
let stored: NotifyConfig = config();

/// Wait for the pane to have read its config. Anchored on a radio rather than
/// on the prefix text, which also appears in the prose above the table.
const ready = () => screen.findByRole("radio", { name: "agent.turn.failed: Off" });

/// The "add a rule" field.
///
/// `combobox`, not `textbox`: an `<input>` carrying a `list` attribute has an
/// implicit combobox role, because a datalist makes it one. Worth knowing
/// before the next test queries for a textbox and gets nothing.
const newRuleField = () => screen.getByRole("combobox", { name: /new rule prefix/i });

/// The config as last written across the boundary.
const written = () => lastInvokeArgs("notify_set_config")?.config as NotifyConfig | undefined;

beforeEach(() => {
  stored = config();
  resetToasts();
  mockTauri({
    notify_config: () => stored,
    notify_set_config: undefined,
    notify_test_cue: undefined,
  });
});

describe("reading", () => {
  it("shows a row per rule", async () => {
    render(() => <NotificationsPane />);
    // By cell, not by text: the prose above the table names
    // `agent.turn.failed` too, and a bare text query would pass on whichever
    // the DOM reached first — including when the row was missing entirely.
    expect(await screen.findByRole("cell", { name: "agent.turn.failed" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "agent.turn.finished" })).toBeInTheDocument();
  });

  it("selects the level each rule is actually set to", async () => {
    render(() => <NotificationsPane />);
    const both = await screen.findByRole("radio", { name: "agent.turn.failed: Both" });
    expect(both).toBeChecked();
    expect(screen.getByRole("radio", { name: "agent.turn.failed: Off" })).not.toBeChecked();
  });

  /// A settings pane that renders an empty table while it reads looks like a
  /// pane with no settings.
  it("says it is loading rather than showing an empty table", () => {
    render(() => <NotificationsPane />);
    expect(screen.getByText(/reading notification settings/i)).toBeInTheDocument();
  });
});

describe("writing through", () => {
  it("sends the whole config when a level changes", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.click(screen.getByRole("radio", { name: "agent.turn.failed: Off" }));

    await waitFor(() => expect(tauriCalls("notify_set_config")).toHaveLength(1));
    expect(written()?.rules).toContainEqual({ prefix: "agent.turn.failed", level: "silent" });
    // And left every other rule alone.
    expect(written()?.rules).toContainEqual({ prefix: "agent.turn.finished", level: "banner" });
  });

  it("writes the mute switch", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.click(screen.getByRole("checkbox", { name: /mute every notification/i }));
    await waitFor(() => expect(written()?.muted).toBe(true));
  });

  /// The rules stay editable in the DOM while muted would be a screen that
  /// invites changes it is ignoring.
  it("disables the matrix while muted", async () => {
    stored = config({ muted: true });
    render(() => <NotificationsPane />);
    const radio = await screen.findByRole("radio", { name: "agent.turn.failed: Off" });
    expect(radio).toBeDisabled();
  });

  it("adds a rule at banner level", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.type(newRuleField(), "review.");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(written()?.rules).toContainEqual({ prefix: "review.", level: "banner" }),
    );
  });

  /// Two rows with the same prefix would make the longest-prefix rule in Rust
  /// depend on which duplicate `max_by_key` happened to keep.
  it("refuses a duplicate prefix instead of adding a second row", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.type(
      newRuleField(),
      "agent.turn.failed",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(tauriCalls("notify_set_config")).toHaveLength(0);
    // Against the toast store rather than the DOM: toasts render through a
    // Portal owned by `ToastViewport`, which this test does not mount. The
    // store is where the fact is; the viewport has its own test.
    expect(useToasts().toasts()[0]?.message).toMatch(/already a rule/i);
  });

  it("removes a rule", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.click(
      screen.getByRole("button", { name: /remove the rule for agent.turn.failed/i }),
    );

    await waitFor(() =>
      expect(written()?.rules.map((r) => r.prefix)).toEqual(["agent.turn.finished"]),
    );
  });

  /// Quiet hours default to something sensible when switched on. An empty pair
  /// of pickers is a control the user has to finish configuring before it does
  /// anything, and half of them will not.
  it("turns quiet hours on with a usable default", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.click(screen.getByRole("checkbox", { name: /say nothing between/i }));
    await waitFor(() => expect(written()?.quietHours).toEqual([22, 8]));
  });

  it("keeps the other end when one quiet hour changes", async () => {
    stored = config({ quietHours: [22, 8] });
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.selectOptions(
      screen.getByRole("combobox", { name: /quiet hours start/i }),
      "23",
    );
    await waitFor(() => expect(written()?.quietHours).toEqual([23, 8]));
  });
});

describe("the test cue", () => {
  /// It has to go through the same Rust path a real cue does. A preview that
  /// was louder or quieter than the thing being previewed is worse than none.
  it("asks Rust to play, rather than previewing something of its own", async () => {
    const user = userEvent.setup();
    render(() => <NotificationsPane />);
    await ready();

    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(tauriCalls("notify_test_cue")).toHaveLength(1));
  });
});
