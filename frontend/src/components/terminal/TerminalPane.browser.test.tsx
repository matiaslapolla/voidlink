/// Right-click against a *real* terminal, in a real browser.
///
/// The predicate is unit-tested in `terminalMenu.test.ts`; what cannot be
/// proven there is the half that caused the bug — that a live `Terminal`, fed
/// the escape sequence a TUI actually sends, flips `modes.mouseTrackingMode`,
/// and that the pane's handler then leaves the event alone. jsdom cannot host
/// xterm (no layout, no measurable cell), so this lives in the browser project
/// for the reason `vitest.config.ts` describes.
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { mockTauri, tauriCalls, tauriChannels } from "@/test/tauri";
import { TerminalPane } from "./TerminalPane";

/// DECSET 1000 — "report button press and release". The first thing lazygit,
/// btop and claude send once they own the screen.
const ENABLE_MOUSE_REPORTING = "\x1b[?1000h";

/// The class xterm puts on its element while the application is tracking the
/// mouse (`MouseEventCssClasses.ENABLE_MOUSE_EVENTS`). Writing is asynchronous
/// — the parser runs off a task — so this is what tells the test the mode has
/// actually landed, rather than a timer.
const MOUSE_ENABLED = ".xterm.enable-mouse-events";

async function mountPane(): Promise<HTMLElement> {
  mockTauri({
    pty_subscribe: { token: 1, replayBytes: 0 },
    pty_unsubscribe: null,
    pty_set_paused: null,
    resize_pty: null,
    write_pty: null,
  });
  const { container } = render(() => <TerminalPane ptyId="pty-right-click" active={true} />);
  await waitFor(() => expect(container.querySelector(".xterm-screen")).toBeTruthy());
  return container;
}

/// Feed the terminal as the PTY reader would: the pane's output `Channel`,
/// carrying raw bytes.
function writeFromPty(text: string): void {
  const channel = tauriChannels<ArrayBuffer>().at(-1)!;
  channel.send(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

/// Right-click where the user does: on the rendered grid, so the event starts
/// inside xterm's own DOM and bubbles out through the pane exactly as a real
/// one would.
function rightClick(container: HTMLElement, shiftKey = false): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey });
  container.querySelector(".xterm-screen")!.dispatchEvent(event);
  return event;
}

/// The pane's menu renders through a `Portal` (`ui/Menu`), so it is never a
/// descendant of the render container.
function openMenu(): HTMLElement | null {
  return document.querySelector('[role="menu"]');
}

/// Real browser, so `navigator.clipboard` exists; only its permission is
/// missing under Playwright's default headless context. Shadowing `readText`
/// with an own property is enough to answer it without touching that context.
function stubClipboardRead(text: string): void {
  navigator.clipboard.readText = async () => text;
}

describe("a right-click on the terminal grid", () => {
  it("pastes the clipboard into the pty while nothing is tracking the mouse", async () => {
    stubClipboardRead("echo hi");
    const container = await mountPane();
    const event = rightClick(container);
    expect(event.defaultPrevented).toBe(true);
    // Right-click-to-paste is the new default (item 3); the menu no longer
    // opens on a plain right-click at all — see the Shift-only case below.
    expect(openMenu()).toBeNull();
    await waitFor(() => expect(tauriCalls("write_pty")).toHaveLength(1));
    expect(tauriCalls("write_pty")[0].args.data).toBe("echo hi");
  });

  it("is left for the application once it has asked for the mouse", async () => {
    const container = await mountPane();
    writeFromPty(ENABLE_MOUSE_REPORTING);
    await waitFor(() => expect(container.querySelector(MOUSE_ENABLED)).toBeTruthy());

    const event = rightClick(container);
    // The whole bug in one assertion: the press was reported, so the release
    // has to be able to follow it. Nothing of ours may intercept the gesture —
    // not the menu, and not the new paste-on-plain-right-click either.
    expect(event.defaultPrevented).toBe(false);
    expect(openMenu()).toBeNull();
    expect(tauriCalls("write_pty")).toHaveLength(0);
  });

  it("still opens the pane's menu on Shift+right-click while tracking is on", async () => {
    const container = await mountPane();
    writeFromPty(ENABLE_MOUSE_REPORTING);
    await waitFor(() => expect(container.querySelector(MOUSE_ENABLED)).toBeTruthy());

    const event = rightClick(container, true);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(openMenu()).toBeTruthy());
    expect(openMenu()!.textContent).toContain("Paste");
  });

  it("opens the pane's menu on Shift+right-click even while nothing is tracking the mouse", async () => {
    // Shift is now the *only* way to the menu (item 3), not just the escape
    // hatch from a tracking application — a plain right-click here pastes
    // instead (see the first test above).
    const container = await mountPane();
    const event = rightClick(container, true);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(openMenu()).toBeTruthy());
    expect(openMenu()!.textContent).toContain("Paste");
    expect(tauriCalls("write_pty")).toHaveLength(0);
  });
});
