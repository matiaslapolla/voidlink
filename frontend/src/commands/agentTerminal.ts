/// Launching a roster agent as a real terminal session.
///
/// The other agent surface — `commands/agent.ts` — pipes one grounded prompt to
/// a CLI's stdin and renders stdout. That is the right shape for "summarise
/// this diff" and the wrong one for Claude Code, which is a *session*: it holds
/// context across turns, it edits files, and it stops to ask permission. There
/// is nothing on the far end of a pipe to answer that question with, so an
/// agent that needs to ask one can only hang.
///
/// So this is the other half: the composed command runs in a PTY beside the
/// user's other shells. It costs nothing new in Rust — `createPty` and
/// `writePty` already exist, and the worktree wizard's post-create step has
/// been running commands this way since before agents did. What it buys is
/// everything the terminal already gives: scrollback, the process-state LED,
/// the sidebar's "Needs You" count, and a permission prompt the user can
/// actually answer.
///
/// Lives in `commands/` rather than in the layout store because composing the
/// command needs the settings store, and the layout store deliberately cannot
/// reach it (see `openAgentTab`). One module that knows both, instead of a
/// dependency between two that should not have one.
import { terminalApi } from "@/api/terminal";
import { pushToast } from "@/commands/toast";
import { agentById, agentLaunchCommand } from "@/store/settings";
import type { AppStore } from "@/store/layout";

/// Open a terminal in `wtId` running the agent `agentId` composes to.
///
/// Returns the new terminal's id, or `null` when nothing was opened — an id
/// that is no longer in the roster, an entry that is a hand-written command
/// rather than a composed one, or a PTY that would not spawn. Every one of
/// those is reported as a toast rather than swallowed: the user asked for a
/// terminal by name from a menu, and a menu item that appears to do nothing is
/// the failure mode this function exists to avoid.
export async function launchAgentTerminal(
  store: AppStore,
  wtId: string,
  agentId: string,
): Promise<string | null> {
  const entry = agentById(agentId);
  if (!entry) {
    pushToast("That agent is no longer in the roster — check Settings → AI.", "error");
    return null;
  }
  const command = agentLaunchCommand(entry);
  if (!command) {
    // A command agent is a filter, not a session: running one in a PTY would
    // block on an empty stdin forever, looking like a terminal that hung.
    pushToast(
      `${entry.name} is a command agent — only Claude agents open as a terminal.`,
      "error",
      6000,
    );
    return null;
  }

  let termId: string | null = null;
  try {
    // The terminal wears the agent's name, which is also what `--name` puts in
    // Claude's own prompt box. Two labels for one thing, deliberately: the tab
    // is what the user reads while the pane is in the background.
    termId = await store.actions.spawnTerminal(wtId, entry.name);
  } catch (e) {
    pushToast(`Couldn't open a terminal for ${entry.name}: ${String(e)}`, "error", 7000);
    return null;
  }
  const session = termId ? store.actions.findTerminal(wtId, termId) : null;
  if (!session) {
    pushToast(`Couldn't open a terminal for ${entry.name}.`, "error");
    return null;
  }

  try {
    // A trailing newline, so it runs rather than sitting on the prompt.
    // Deliberately *typed into the shell* rather than made the PTY's argv: the
    // command stays visible in scrollback, which is the only way a user can
    // check what the form actually composed, and `Ctrl-C` leaves them in a
    // working shell instead of closing the tab.
    await terminalApi.writePty(session.ptyId, `${command}\n`);
  } catch (e) {
    // The terminal is open and usable — it just has nothing typed into it, and
    // the command is on screen in the settings pane to paste. Not worth
    // closing a shell the user can still work in.
    pushToast(`${entry.name}'s terminal opened, but the command didn't run: ${String(e)}`, "error", 7000);
  }
  return termId;
}
