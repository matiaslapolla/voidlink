/// The dock strip, mounted with a real store.
///
/// Four properties, and every one of them is something a screenshot of the
/// strip would show as correct while it was wrong:
///
///   1. **The buttons follow `dockOrder`.** The dock does not invent a second
///      arrangement — a panel dragged to the front of an edge is the panel at
///      the front of the strip. A dock that hardcoded `SIDEBAR_IDS` would look
///      identical on a default install and be wrong on every other one.
///   2. **The divider is there**, between "panels I can open" and "things that
///      are running". Two sections of icons with no rule between them is one
///      long list of unrelated targets.
///   3. **One icon per running process**, terminals and agent threads alike,
///      across the whole active workspace rather than the active worktree.
///   4. **The tooltip carries the *live* label** — the foreground process's
///      name while the shell is busy, not the tab's own name. That is the whole
///      reason the second section is worth 28px each: the icon says "a
///      terminal" and the tooltip says which one and what it is doing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";

vi.mock("@/api/terminal", () => ({
  terminalApi: {
    createPty: async () => `pty-${ptyCounter++}`,
    closePty: async () => {},
    writePty: async () => {},
    processInfo: async () => null,
  },
}));

/// The live-label source, faked at the module the dock actually reads.
///
/// Deliberately not a fake `processInfo` underneath the real watcher: that
/// would make this test depend on the poll interval, and what is being asserted
/// is that the dock *reads the shared watcher* rather than growing a poll of
/// its own. `terminalWatch.test.ts` owns the watcher's own behaviour.
///
/// The fake's fields are signals, not plain values: the real watcher's are, and
/// what this test is checking is that the label the dock renders *tracks* them.
/// A fake that returned a captured value would pass the first assertion and
/// prove nothing about the second.
/// The two setters come back out *through the mocked module* rather than
/// through a module-scope variable the factory assigns: `vi.mock` is hoisted
/// above every import, so the factory runs before any `let` here is
/// initialised, and closing over one is a temporal-dead-zone error at import.
vi.mock("@/store/terminalWatch", async () => {
  const { createSignal } = await import("solid-js");
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal<string | null>(null);
  return {
    watchTerminal: () => ({
      busy,
      working: busy,
      processName: name,
      agent: () => false,
      waiting: () => false,
    }),
    terminalLastActivity: () => null,
    setFakeBusy: setBusy,
    setFakeName: setName,
  };
});

import * as terminalWatch from "@/store/terminalWatch";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { TooltipLayer } from "@/components/ui/Tooltip";

import { DockStrip, closeDockPanel, closingPanel, openPanel } from "./DockStrip";

let ptyCounter = 1;
const fakeWatch = terminalWatch as unknown as {
  setFakeBusy: (v: boolean) => void;
  setFakeName: (v: string | null) => void;
};

const WS_ID = "88888888-8888-4888-8888-888888888888";
const WT_ID = "77777777-7777-4777-8777-777777777777";
/// A second worktree of the *same* workspace. The dock's second section is
/// workspace-wide on purpose — a build running in the checkout you are not
/// looking at is exactly the one worth a dot — so a test with one worktree
/// could not tell the two scopes apart.
const WT2_ID = "66666666-6666-4666-8666-666666666666";

function installLocalStorage() {
  const backing = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k) => backing.get(k) ?? null,
    key: (i) => [...backing.keys()][i] ?? null,
    removeItem: (k) => void backing.delete(k),
    setItem: (k, v) => void backing.set(k, String(v)),
  };
  (globalThis as { localStorage: Storage }).localStorage = stub;
  return backing;
}

function seed(backing: Map<string, string>) {
  backing.set(LAYOUT_VERSION_KEY, String(LAYOUT_VERSION));
  backing.set(
    WORKSPACES_KEY,
    JSON.stringify([
      {
        id: WS_ID,
        name: "Main",
        repoRoot: "/repo",
        worktrees: [
          { id: WT_ID, path: "/repo", branch: "main", isMain: true, isSynthetic: false },
          {
            id: WT2_ID,
            path: "/repo-wt",
            branch: "feature",
            isMain: false,
            isSynthetic: false,
          },
        ],
        activeWorktreeId: WT_ID,
        isRepo: true,
      },
    ]),
  );
}

function mount() {
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <DockStrip />
      <TooltipLayer />
    </AppStoreContext.Provider>
  ));
  return { store, container };
}

const panelIds = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-dock-panel]")].map((el) =>
    el.getAttribute("data-dock-panel"),
  );

beforeEach(() => {
  ptyCounter = 1;
  fakeWatch.setFakeBusy(false);
  fakeWatch.setFakeName(null);
  seed(installLocalStorage());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DockStrip", () => {
  it("renders a toolbar with one button per dockable sidebar, in dock order", () => {
    const { store, container } = mount();
    expect(screen.getByRole("toolbar", { name: "Dock" })).toBeInTheDocument();
    // The agent dashboard is behind an experimental flag and absent by
    // default, exactly as its sidebar slot is — a button for a panel that
    // cannot be rendered is a control that lies.
    expect(panelIds(container)).toEqual(
      store.state.dockOrder.filter((id) => id !== "agents"),
    );
  });

  it("follows the user's arrangement rather than a hardcoded list", () => {
    const { store, container } = mount();
    store.actions.dockSidebar("git", "left", "workspaces");
    expect(panelIds(container)[0]).toBe("git");
  });

  it("drops a detached panel's button, like the shell drops its slot", () => {
    const { store, container } = mount();
    expect(panelIds(container)).toContain("explorer");
    store.actions.setSidebarDetached("explorer", true);
    expect(panelIds(container)).not.toContain("explorer");
  });

  it("puts a divider between the panel buttons and the process icons", () => {
    const { container } = mount();
    const divider = container.querySelector("[data-dock-divider]");
    expect(divider).toBeInTheDocument();
    expect(divider?.getAttribute("role")).toBe("separator");
    // Across the strip's own axis: a separator runs perpendicular to what it
    // separates, and the strip is vertical on its default left edge.
    expect(divider?.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("shows nothing after the divider until something is running", () => {
    const { container } = mount();
    expect(container.querySelectorAll("[data-dock-process]")).toHaveLength(0);
  });

  it("draws one icon per running terminal and agent thread across the workspace", async () => {
    const { store, container } = mount();
    await store.actions.spawnTerminal(WT_ID, "build");
    // The second worktree's shell counts too — the section is workspace-wide.
    await store.actions.spawnTerminal(WT2_ID, "server");
    store.actions.openAgentTab(WT_ID, "claude", "Claude");

    const keys = [...container.querySelectorAll("[data-dock-process]")].map((el) =>
      el.getAttribute("data-dock-process"),
    );
    expect(keys).toHaveLength(3);
    expect(keys.filter((k) => k?.startsWith("terminal:"))).toHaveLength(2);
    expect(keys.filter((k) => k?.startsWith("agent:"))).toHaveLength(1);

    expect(screen.getByRole("button", { name: "Terminal: build" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal: server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent: Claude" })).toBeInTheDocument();
  });

  it("loses a process icon when its shell closes", async () => {
    const { store, container } = mount();
    const id = await store.actions.spawnTerminal(WT_ID, "build");
    expect(container.querySelectorAll("[data-dock-process]")).toHaveLength(1);
    store.actions.removeTerminal(WT_ID, id!);
    expect(container.querySelectorAll("[data-dock-process]")).toHaveLength(0);
  });

  /// The one that justifies the second section existing at all.
  it("tooltips a process with its live label, not the tab's own name", async () => {
    vi.useFakeTimers();
    const { store, container } = mount();
    await vi.advanceTimersByTimeAsync(0);
    await store.actions.spawnTerminal(WT_ID, "Terminal 1");

    // The shell is now running `vitest`, which is what the terminal tab strip
    // shows and therefore what the dock has to show.
    fakeWatch.setFakeBusy(true);
    fakeWatch.setFakeName("vitest");

    const button = container.querySelector<HTMLElement>("[data-dock-process]");
    expect(button).not.toBeNull();
    // The accessible name carries it too: at 28px the glyph says "a terminal"
    // and nothing else, so a screen reader that never sees the tooltip still
    // hears which one.
    expect(button!.getAttribute("aria-label")).toBe("Terminal: vitest");

    button!.dispatchEvent(new Event("pointerenter"));
    // `--delay-tooltip`, which jsdom reports as empty and the directive falls
    // back to 650ms for.
    await vi.advanceTimersByTimeAsync(700);
    expect(screen.getByRole("tooltip")).toHaveTextContent("vitest");

    // And back to the tab's own name the moment the shell goes quiet.
    fakeWatch.setFakeBusy(false);
    expect(button!.getAttribute("aria-label")).toBe("Terminal: Terminal 1");
  });

  it("runs across the strip, and orients its divider with it, on the bottom edge", () => {
    const { store, container } = mount();
    const strip = container.querySelector("[data-dock-strip]")!;
    expect(strip.getAttribute("aria-orientation")).toBe("vertical");

    store.actions.setDockStripSide("bottom");
    expect(strip.getAttribute("data-dock-strip")).toBe("bottom");
    expect(strip.getAttribute("aria-orientation")).toBe("horizontal");
    expect(container.querySelector("[data-dock-divider]")?.getAttribute("aria-orientation")).toBe(
      "vertical",
    );
  });
});

/// The exit animation's *state machine*, not its pixels.
///
/// jsdom implements neither WAAPI nor layout, so both are stubbed — deliberately
/// and narrowly. What is under test is the thing that has a wrong answer: a
/// panel has to outlive the signal that closed it for exactly as long as it
/// takes to leave, and not one interruption longer. The keyframes are the
/// browser's problem and `dockMorph.test.ts` owns the tokens.
describe("closing a panel", () => {
  /// A slot for `AppShell`'s `data-sidebar` hook, with a box — `runDockMorph`
  /// bails on a zero-size element, which every jsdom element is.
  function fakeSlot(id: string): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-sidebar", id);
    el.getBoundingClientRect = () =>
      ({ left: 46, top: 0, width: 256, height: 800 }) as DOMRect;
    document.body.appendChild(el);
    return el;
  }

  /// A controllable `Element.animate`. `finished` is resolved by the test, so
  /// the window in which the panel is still mounted is explicit rather than a
  /// timer the test has to outwait.
  function fakeWaapi() {
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => (settle = resolve));
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ finished, cancel }));
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    return { settle, cancel, animate };
  }

  // `openPanel` is module state by design (see `DockStrip.tsx`), so it carries
  // across tests in this file. Reset explicitly rather than relying on the
  // order these run in.
  beforeEach(() => closeDockPanel());

  afterEach(() => {
    closeDockPanel();
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
    document.querySelectorAll("[data-sidebar]").forEach((el) => el.remove());
  });

  /// `detail: 1` is a pointer click. A `0` there is the keyboard, which §7.1
  /// gives no motion at all — the case `dockMorph.test.ts` covers.
  const press = (container: HTMLElement, id: string) => {
    const button = container.querySelector<HTMLElement>(`[data-dock-panel="${id}"]`)!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  };

  it("keeps the panel mounted until its exit finishes", async () => {
    const waapi = fakeWaapi();
    fakeSlot("explorer");
    const { container } = mount();

    press(container, "explorer");
    expect(openPanel()).toBe("explorer");
    expect(closingPanel()).toBe(null);

    press(container, "explorer");
    // The button is unpressed immediately — press feedback gets no delay — but
    // the panel is still there, which is the whole point.
    expect(openPanel()).toBe(null);
    expect(closingPanel()).toBe("explorer");

    waapi.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(closingPanel()).toBe(null);
  });

  it("drops a panel that is still leaving when another opens", async () => {
    const waapi = fakeWaapi();
    fakeSlot("explorer");
    fakeSlot("git");
    const { container } = mount();

    press(container, "explorer");
    press(container, "explorer");
    expect(closingPanel()).toBe("explorer");

    // Two floated panels on one edge, stacked, is what this prevents.
    press(container, "git");
    expect(closingPanel()).toBe(null);
    expect(openPanel()).toBe("git");
    expect(waapi.cancel).toHaveBeenCalled();
  });

  it("unmounts immediately when there is nothing to animate", () => {
    // No WAAPI stub and no slot: `runDockMorph` returns null, and a null
    // animation must mean "already done" rather than a panel left mounted
    // forever waiting on a promise that never arrives.
    const { container } = mount();
    press(container, "explorer");
    press(container, "explorer");
    expect(openPanel()).toBe(null);
    expect(closingPanel()).toBe(null);
  });
});
