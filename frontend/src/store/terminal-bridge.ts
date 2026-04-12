import { createSignal } from "solid-js";

/** Global signal for injecting text into the active bottom-pane terminal */
const [pendingTerminalInput, setPendingTerminalInput] = createSignal<string | null>(null);

export function sendToTerminal(text: string) {
  setPendingTerminalInput(text);
}

export function consumeTerminalInput(): string | null {
  const val = pendingTerminalInput();
  if (val) setPendingTerminalInput(null);
  return val;
}

export { pendingTerminalInput };
