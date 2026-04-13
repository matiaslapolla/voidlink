import type { Terminal, ITerminalAddon, IDisposable, IMarker } from "@xterm/xterm";

/**
 * Custom xterm.js addon that parses OSC 133 (FinalTerm prompt protocol)
 * and OSC 7 (CWD reporting) escape sequences.
 *
 * OSC 133 lifecycle:
 *   A — prompt start
 *   B — prompt end (user input begins)
 *   C — command execution starts
 *   D;N — command finished with exit code N
 */

export interface CommandMarker {
  promptMarker: IMarker;
  exitCode?: number;
}

export class ShellIntegrationAddon implements ITerminalAddon {
  private disposables: IDisposable[] = [];
  private commands: CommandMarker[] = [];
  private currentPromptMarker: IMarker | null = null;
  private cwd: string | null = null;

  /** Callback when CWD changes (from OSC 7). */
  public onCwdChange: ((cwd: string) => void) | null = null;

  activate(terminal: Terminal): void {
    // OSC 133 — prompt marking (data tracking only, no DOM decorations)
    const osc133 = terminal.parser.registerOscHandler(133, (data: string) => {
      const cmd = data[0];
      switch (cmd) {
        case "A":
          this.currentPromptMarker = terminal.registerMarker(0);
          break;
        case "D": {
          const exitCode = parseInt(data.slice(2), 10) || 0;
          if (this.currentPromptMarker) {
            this.commands.push({
              promptMarker: this.currentPromptMarker,
              exitCode,
            });
            this.currentPromptMarker = null;
          }
          break;
        }
      }
      return true;
    });
    this.disposables.push(osc133);

    // OSC 7 — CWD reporting (file://hostname/path)
    const osc7 = terminal.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        this.cwd = decodeURIComponent(url.pathname);
        this.onCwdChange?.(this.cwd);
      } catch {
        // malformed URL, ignore
      }
      return true;
    });
    this.disposables.push(osc7);
  }

  /** Get the current working directory reported by the shell. */
  getCwd(): string | null {
    return this.cwd;
  }

  /** Get all completed command markers. */
  getCommands(): ReadonlyArray<CommandMarker> {
    return this.commands;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.commands = [];
  }
}
