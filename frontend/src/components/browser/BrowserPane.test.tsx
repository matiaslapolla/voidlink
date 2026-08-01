/// `BrowserPane`, mounted.
///
/// The page itself is an OS-level child webview that no test environment can
/// host, so what is under test here is everything on *this* side of the
/// boundary: which commands the strip sends, what the two events do to the
/// address bar, and the lifecycle rules that decide whether a webview is left
/// floating with nothing owning it.
///
/// Nothing mocks a module — only `invoke` is faked, so `@/api/webview`'s
/// argument shaping is under test rather than replaced. See `@/test/tauri`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { emitTauriEvent, lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { resetToasts, useToasts } from "@/commands/toast";
import type { BrowserTab } from "@/store/layout";

import { BrowserPane } from "./BrowserPane";

const BLOCKED = "voidlink://browser-blocked";
const NAVIGATING = "voidlink://browser-navigating";
const COMMITTED = "voidlink://browser-committed";
const NAVIGATED = "voidlink://browser-navigated";

function tab(partial: Partial<BrowserTab> = {}): BrowserTab {
  return { id: "tab-1", url: "https://example.com/", ...partial };
}

/// The commands every mount makes. A test that cares about one of them
/// overrides it; the rest just have to not reject, because an unhandled
/// command is a rejection by design in this harness.
function mountDefaults() {
  mockTauri({
    browser_open: null,
    browser_close: null,
    browser_show: null,
    browser_hide: null,
    browser_navigate: null,
    browser_reload: null,
    browser_focus_host: null,
    browser_set_zoom: null,
    browser_toggle_devtools: true,
  });
}

/// Mount and wait for the webview to exist, which is the point every other
/// interaction depends on — the strip's buttons are live before it, and would
/// be asserted against a component still in its first await otherwise.
async function mountPane(props: Partial<Parameters<typeof BrowserPane>[0]> = {}) {
  const onUrlChange = vi.fn();
  const onTitleChange = vi.fn();
  const onZoomChange = vi.fn();
  const result = render(() => (
    <BrowserPane
      tab={tab()}
      active={true}
      onUrlChange={onUrlChange}
      onTitleChange={onTitleChange}
      onZoomChange={onZoomChange}
      {...props}
    />
  ));
  await waitFor(() => expect(tauriCalls("browser_open")).toHaveLength(1));
  return { ...result, onUrlChange, onTitleChange, onZoomChange };
}

beforeEach(() => {
  resetToasts();
  mountDefaults();
});

describe("the address bar and the page's focus", () => {
  /// The defect this pane was audited for. A child webview is a sibling native
  /// view: once the page has been clicked it owns the OS keyboard focus, and
  /// nothing inside this document can take it back — `HTMLElement.focus()`
  /// moves focus only within a webview that already has it. Only Rust can, so
  /// the strip must ask.
  it("asks Rust for the keyboard focus when the strip is clicked", async () => {
    const user = userEvent.setup();
    await mountPane();

    expect(tauriCalls("browser_focus_host")).toHaveLength(0);
    await user.click(screen.getByLabelText("Address"));

    await waitFor(() => expect(tauriCalls("browser_focus_host")).toHaveLength(1));
  });

  /// The buttons need it too. They are clicked, not typed into, but a click
  /// that leaves the focus in the page means the *next* keystroke still goes
  /// there — including the Enter the user is about to press in the address bar.
  it("asks for focus when a navigation button is clicked, not just the input", async () => {
    const user = userEvent.setup();
    await mountPane();

    await user.click(screen.getByLabelText("Reload page"));

    await waitFor(() => expect(tauriCalls("browser_focus_host")).toHaveLength(1));
    expect(tauriCalls("browser_reload")).toHaveLength(1);
  });

  it("navigates to what was typed, normalising a bare host", async () => {
    const user = userEvent.setup();
    await mountPane();

    const input = screen.getByLabelText("Address");
    await user.clear(input);
    await user.type(input, "localhost:5173{Enter}");

    await waitFor(() => expect(tauriCalls("browser_navigate")).toHaveLength(1));
    // `localhost` is the one host that must not get https — dev servers do not
    // do TLS, and this is the address most often typed into this bar.
    expect(lastInvokeArgs("browser_navigate")).toMatchObject({
      tabId: "tab-1",
      url: "http://localhost:5173",
    });
  });

  /// A dev server on the LAN is the same case as one on this machine, and used
  /// to be handed an `https://` it could not answer.
  it("does not assume TLS for a dev server on the network", async () => {
    const user = userEvent.setup();
    await mountPane();

    const input = screen.getByLabelText("Address");
    await user.clear(input);
    await user.type(input, "192.168.1.5:3000{Enter}");

    await waitFor(() => expect(tauriCalls("browser_navigate")).toHaveLength(1));
    expect(lastInvokeArgs("browser_navigate")).toMatchObject({
      url: "http://192.168.1.5:3000",
    });
  });

  /// Anything without a scheme used to be prefixed with `https://` and sent to
  /// Rust regardless, where a phrase failed `Url::parse` and came back as a red
  /// toast naming a parser error. Nothing is sent now, and — deliberately — no
  /// search engine is reached for either.
  it("refuses to send a phrase to the engine, and leaves the page alone", async () => {
    const user = userEvent.setup();
    await mountPane();

    const input = screen.getByLabelText("Address");
    await user.clear(input);
    await user.type(input, "git rebase onto{Enter}");

    await Promise.resolve();
    expect(tauriCalls("browser_navigate")).toHaveLength(0);
    // The error state hides the webview; a typo must not cost the user the
    // page they were reading.
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });
});

/// BR-S3. The rule itself is a pure function tested exhaustively in
/// `url.test.ts` (and again, in Rust, in `browser/mod.rs`). What is under test
/// here is the half that only exists in this component: **that a refusal is
/// ever seen at all.**
///
/// It matters more than it looks. Enforcement is the Rust hook, and the hook
/// cancels by returning `false`, which produces no error, no load event and no
/// change on screen. A policy that blocks and says nothing is indistinguishable
/// from an app that has hung — a worse bug than the unrestricted `file://` it
/// removes.
///
/// **What no test in this repo can reach:** that returning `false` actually
/// stops a real child webview. That needs an OS-level native view and a page
/// trying to navigate. The tests below drive the *event* the hook emits, which
/// is the contract this side of the boundary depends on.
describe("the url policy", () => {
  /// The address bar has to give the same answer as the hook. If it accepted a
  /// URL the hook will cancel, Enter would send it and then nothing would
  /// happen, anywhere, forever.
  it("refuses a local file the tab cannot render instead of sending it", async () => {
    const user = userEvent.setup();
    await mountPane();

    const input = screen.getByLabelText("Address");
    await user.clear(input);
    await user.type(input, "file:///Users/me/.ssh/id_rsa{Enter}");

    await Promise.resolve();
    expect(tauriCalls("browser_navigate")).toHaveLength(0);
    expect(useToasts().toasts()).toHaveLength(1);
    expect(useToasts().toasts()[0].message).toMatch(/web page, a text file or a PDF/);
    // A refusal must not cost the user the page they were reading — the error
    // state hides the webview and replaces it with a retry screen.
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it("still sends a local file the tab can render", async () => {
    const user = userEvent.setup();
    await mountPane();

    const input = screen.getByLabelText("Address");
    await user.clear(input);
    await user.type(input, "file:///Users/me/coverage/index.html{Enter}");

    await waitFor(() => expect(tauriCalls("browser_navigate")).toHaveLength(1));
    expect(lastInvokeArgs("browser_navigate")).toMatchObject({
      url: "file:///Users/me/coverage/index.html",
    });
  });

  /// A navigation this component never asked for — a link the user clicked, an
  /// iframe the page pulled. The event is the only channel; the cancel itself
  /// is silent.
  it("says so when the hook cancels a navigation nothing here requested", async () => {
    await mountPane();

    emitTauriEvent(BLOCKED, {
      tabId: "tab-1",
      url: "file:///Users/me/wallet.dat",
      reason: "file-type",
    });

    await waitFor(() => expect(useToasts().toasts()).toHaveLength(1));
    expect(useToasts().toasts()[0].message).toContain("file:///Users/me/wallet.dat");
  });

  /// **The subframe case.** The hook cannot tell a subframe from a top-level
  /// navigation — wry's macOS navigation policy never consults `isMainFrame` —
  /// so one page pulling ten blocked frames emits ten of these. Ten toasts for
  /// one page would be its own bug, so they coalesce onto one `source` key and
  /// arrive as a single line carrying a count.
  it("folds a page's worth of blocked frames into one toast with a count", async () => {
    await mountPane();

    for (let i = 0; i < 10; i++) {
      emitTauriEvent(BLOCKED, {
        tabId: "tab-1",
        url: `file:///Users/me/leak-${i}.png`,
        reason: "file-type",
      });
    }

    await waitFor(() => expect(useToasts().toasts()[0]?.count).toBe(10));
    expect(useToasts().toasts()).toHaveLength(1);
  });

  /// Every tab hears every tab's events, and a refusal in someone else's tab is
  /// not this pane's news to report.
  it("ignores a refusal in another tab", async () => {
    await mountPane();

    emitTauriEvent(BLOCKED, {
      tabId: "tab-2",
      url: "file:///Users/me/other.png",
      reason: "file-type",
    });

    await Promise.resolve();
    expect(useToasts().toasts()).toHaveLength(0);
  });
});

describe("what the page reports", () => {
  it("shows where a load is going while it is still in flight", async () => {
    await mountPane();

    emitTauriEvent(COMMITTED, { tabId: "tab-1", url: "https://next.test/page" });

    await waitFor(() =>
      expect(screen.getByLabelText("Address")).toHaveValue("https://next.test/page"),
    );
    // The reload control doubles as the progress indicator, so a load in
    // flight has to be legible on it rather than on a second element.
    expect(screen.getByLabelText("Reload page")).toHaveAttribute("aria-busy", "true");
  });

  /// The two mid-flight events say different things and only one of them is
  /// main-frame-only. wry's macOS navigation policy never checks
  /// `isMainFrame`, so the navigating event fires for every iframe a page
  /// loads — a bar driven off it shows an ad frame's URL as the tab's address.
  it("does not let a subframe's navigation rename the address", async () => {
    await mountPane();

    emitTauriEvent(NAVIGATING, { tabId: "tab-1", url: "https://ads.test/frame" });

    await waitFor(() =>
      expect(screen.getByLabelText("Reload page")).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com/");
  });

  /// The engine has no load-failure event at any layer, so a load that fails
  /// at DNS or connect is indistinguishable from a slow one by its spinner
  /// alone. The commit is the dividing line: reached before it, no server has
  /// answered; reached after, one has.
  it("distinguishes a load that has not reached a server from one that has", async () => {
    await mountPane();

    emitTauriEvent(NAVIGATING, { tabId: "tab-1", url: "https://slow.test/" });
    await waitFor(() =>
      expect(screen.getByLabelText("Reload page")).toHaveAttribute("title", "Connecting…"),
    );

    emitTauriEvent(COMMITTED, { tabId: "tab-1", url: "https://slow.test/" });
    await waitFor(() =>
      expect(screen.getByLabelText("Reload page")).toHaveAttribute("title", "Loading…"),
    );
  });

  it("stops reporting a load once the page settles", async () => {
    await mountPane();

    emitTauriEvent(COMMITTED, { tabId: "tab-1", url: "https://next.test/page" });
    await waitFor(() =>
      expect(screen.getByLabelText("Reload page")).toHaveAttribute("aria-busy", "true"),
    );

    emitTauriEvent(NAVIGATED, {
      tabId: "tab-1",
      url: "https://next.test/page",
      canGoBack: true,
      canGoForward: false,
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Reload page")).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.getByLabelText("Reload page")).toHaveAttribute("title", "Reload");
    expect(screen.getByLabelText("Back")).toBeEnabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
  });

  /// Every tab hears every tab's events, so a pane that did not filter would
  /// show its neighbour's address.
  it("ignores events belonging to another tab", async () => {
    await mountPane();

    emitTauriEvent(NAVIGATED, {
      tabId: "someone-else",
      url: "https://other.test/",
      canGoBack: true,
      canGoForward: true,
    });

    await Promise.resolve();
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com/");
    expect(screen.getByLabelText("Back")).toBeDisabled();
  });
});

describe("zoom", () => {
  it("steps the page scale and reports it for persistence", async () => {
    const user = userEvent.setup();
    const { onZoomChange } = await mountPane();

    await user.click(screen.getByLabelText("Zoom in"));

    await waitFor(() => expect(tauriCalls("browser_set_zoom")).toHaveLength(1));
    expect(lastInvokeArgs("browser_set_zoom")).toMatchObject({ tabId: "tab-1", factor: 1.1 });
    expect(onZoomChange).toHaveBeenCalledWith(1.1);
  });

  /// A tab reopened at 125% has to reach the webview with that scale, or the
  /// number in the strip and the page on screen disagree from the first frame.
  it("applies a persisted scale to a freshly opened webview", async () => {
    await mountPane({ tab: tab({ zoom: 1.25 }) });

    await waitFor(() => expect(tauriCalls("browser_set_zoom")).toHaveLength(1));
    expect(lastInvokeArgs("browser_set_zoom")).toMatchObject({ factor: 1.25 });
    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("does not zoom a tab that was never zoomed", async () => {
    await mountPane();
    // Deliberately not `waitFor`: the assertion is that nothing was sent, and
    // the open has already resolved by the time `mountPane` returns.
    expect(tauriCalls("browser_set_zoom")).toHaveLength(0);
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
  });
});

describe("the inspector", () => {
  it("toggles rather than only opening", async () => {
    const user = userEvent.setup();
    let open = false;
    mockTauri({
      browser_toggle_devtools: () => {
        open = !open;
        return open;
      },
    });
    await mountPane();

    await user.click(screen.getByLabelText("Open devtools"));
    await waitFor(() => expect(screen.getByLabelText("Close devtools")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Close devtools"));
    await waitFor(() => expect(screen.getByLabelText("Open devtools")).toBeInTheDocument());
  });
});

describe("lifecycle", () => {
  /// The leak this pane was audited for. `browser_close` during cleanup finds
  /// no store entry when the open has not resolved yet, so it does nothing —
  /// and the open then puts a child webview on screen that composites above
  /// the entire UI with no component owning it and no way to dismiss it.
  it("closes a webview whose open landed after the tab was gone", async () => {
    let release: (() => void) | undefined;
    mockTauri({
      browser_open: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    });

    const { unmount } = render(() => (
      <BrowserPane tab={tab()} active={true} onUrlChange={vi.fn()} onTitleChange={vi.fn()} />
    ));
    await waitFor(() => expect(tauriCalls("browser_open")).toHaveLength(1));

    unmount();
    // The close that cleanup issues, which Rust answers as a no-op.
    await waitFor(() => expect(tauriCalls("browser_close")).toHaveLength(1));

    release?.();

    // The second close is the one that actually tears the webview down.
    await waitFor(() => expect(tauriCalls("browser_close")).toHaveLength(2));
  });

  it("hides the page rather than covering it when the tab is not the front one", async () => {
    await mountPane({ active: false });
    await waitFor(() => expect(tauriCalls("browser_hide")).toHaveLength(1));
    expect(tauriCalls("browser_show")).toHaveLength(0);
  });

  it("shows the page at a rectangle when the tab is front and its group is drawn", async () => {
    await mountPane({ active: true, groupVisible: true });
    await waitFor(() => expect(tauriCalls("browser_show")).toHaveLength(1));
    expect(lastInvokeArgs("browser_show")).toMatchObject({ tabId: "tab-1" });
  });

  /// A group that has been maximized away is not covered by anything — it is
  /// simply not drawn — and a child webview told nothing would go on painting
  /// over whatever replaced it.
  it("hides the page when its pane group is not drawn at all", async () => {
    await mountPane({ active: true, groupVisible: false });
    await waitFor(() => expect(tauriCalls("browser_hide")).toHaveLength(1));
    expect(tauriCalls("browser_show")).toHaveLength(0);
  });

  it("surfaces a failed open as an error state with a retry", async () => {
    mockTauri({
      browser_open: () => {
        throw new Error("webview label in use");
      },
    });
    await mountPane();

    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument());
    expect(screen.getByText("webview label in use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
