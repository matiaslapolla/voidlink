/// The unified palette: one overlay, two modes.
///
/// The chords themselves are asserted in `keymap.test.ts` (⌘P → `file.open`,
/// ⌘K → `palette.open`); what is left to prove is the half those actions
/// reach — that opening in `"files"` mode lists files and opening in
/// `"commands"` mode lists commands with the `>` already in the box, that the
/// two modes swap on the query alone, and that command mode does not walk the
/// repo for a list it will not draw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { CommandPalette } from "./CommandPalette";
import { closePalette, openPalette, registerActions, type Action } from "./registry";
import { mockTauri, tauriCalls } from "@/test/tauri";
import type { OpenTabTarget, RecentFileTarget } from "./targets";

const FILES = ["src/App.tsx", "src/commands/registry.ts", "README.md"];

/// Ids the palette's command mode should list. Registered per test and torn
/// down after — `registry.ts`'s action list is module-level state, so a leaked
/// registration would show up as a *different* test failing.
function testActions(run: () => void): Action[] {
  return [
    { id: "terminal.new", label: "New terminal", group: "Terminal", run },
    { id: "board.open", label: "Open board…", group: "View", run },
    { id: "browser.new", label: "New browser tab", group: "View", run },
  ];
}

let dispose: (() => void) | undefined;

function mount(opts: { repoPath?: string | null; onOpenFile?: (p: string) => void } = {}) {
  const openTabs = (): OpenTabTarget[] => [
    { id: "t1", label: "zsh", kind: "terminal", open: () => {} },
  ];
  const recentFiles = (): RecentFileTarget[] => [
    { path: "src/gone.ts", label: "gone.ts", open: () => {} },
  ];
  return render(() => (
    <CommandPalette
      openTabs={openTabs}
      recentFiles={recentFiles}
      repoPath={opts.repoPath === undefined ? "/repo" : opts.repoPath}
      onOpenFile={opts.onOpenFile ?? (() => {})}
    />
  ));
}

const keys = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-qp-key]")].map((el) => el.getAttribute("data-qp-key"));

const input = (container: HTMLElement) =>
  container.querySelector("input[role=combobox]") as HTMLInputElement;

beforeEach(() => {
  mockTauri({ git_ls_files: () => FILES });
});

afterEach(() => {
  closePalette();
  dispose?.();
  dispose = undefined;
});

describe("the palette's two modes", () => {
  it("opens in file mode for ⌘P: tracked files, open tabs and recent files, no commands", async () => {
    dispose = registerActions(testActions(() => {}));
    openPalette("files");
    const { baseElement } = mount();

    await waitFor(() => expect(keys(baseElement)).toContain("p:src/App.tsx"));
    expect(input(baseElement).value).toBe("");
    // Resting order: what is open, what was just closed, then the repo.
    expect(keys(baseElement).slice(0, 2)).toEqual(["t:t1", "f:src/gone.ts"]);
    expect(keys(baseElement).some((k) => k?.startsWith("a:"))).toBe(false);
  });

  it("opens in command mode for ⌘K, with the > already typed", async () => {
    dispose = registerActions(testActions(() => {}));
    openPalette("commands");
    const { baseElement } = mount();

    await waitFor(() => expect(input(baseElement).value).toBe(">"));
    expect(keys(baseElement)).toContain("a:terminal.new");
    expect(keys(baseElement)).toContain("a:board.open");
    expect(keys(baseElement)).toContain("a:browser.new");
    expect(keys(baseElement).some((k) => k?.startsWith("p:"))).toBe(false);
  });

  it("ranks the command the user is typing at first — >term finds the new terminal", async () => {
    dispose = registerActions(testActions(() => {}));
    openPalette("commands");
    const { baseElement } = mount();

    fireEvent.input(input(baseElement), { target: { value: ">term" } });
    await waitFor(() => expect(keys(baseElement)[0]).toBe("a:terminal.new"));
  });

  it("switches modes on the query alone — deleting the > goes back to files", async () => {
    dispose = registerActions(testActions(() => {}));
    openPalette("commands");
    const { baseElement } = mount();

    fireEvent.input(input(baseElement), { target: { value: "" } });
    await waitFor(() => expect(keys(baseElement)).toContain("p:src/App.tsx"));
    expect(keys(baseElement).some((k) => k?.startsWith("a:"))).toBe(false);
  });

  it("runs the highlighted command on Enter", async () => {
    const run = vi.fn();
    dispose = registerActions(testActions(run));
    openPalette("commands");
    const { baseElement } = mount();

    fireEvent.input(input(baseElement), { target: { value: ">board" } });
    await waitFor(() => expect(keys(baseElement)[0]).toBe("a:board.open"));
    fireEvent.keyDown(input(baseElement), { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("opens a repo file against the repo root", async () => {
    const onOpenFile = vi.fn();
    openPalette("files");
    const { baseElement } = mount({ onOpenFile });

    await waitFor(() => expect(keys(baseElement)).toContain("p:README.md"));
    const row = baseElement.querySelector('[data-qp-key="p:README.md"]') as HTMLElement;
    fireEvent.click(row);
    expect(onOpenFile).toHaveBeenCalledWith("/repo/README.md");
  });
});

describe("the file list stays lazy", () => {
  it("command mode does not walk the repo", async () => {
    dispose = registerActions(testActions(() => {}));
    openPalette("commands");
    const { baseElement } = mount();

    await waitFor(() => expect(keys(baseElement)).toContain("a:terminal.new"));
    expect(tauriCalls("git_ls_files")).toHaveLength(0);
  });

  it("walks it once, and does not walk it again when the mode flips back and forth", async () => {
    openPalette("files");
    const { baseElement } = mount();

    await waitFor(() => expect(tauriCalls("git_ls_files")).toHaveLength(1));
    fireEvent.input(input(baseElement), { target: { value: ">" } });
    fireEvent.input(input(baseElement), { target: { value: "" } });
    await waitFor(() => expect(keys(baseElement)).toContain("p:src/App.tsx"));
    expect(tauriCalls("git_ls_files")).toHaveLength(1);
  });
});
