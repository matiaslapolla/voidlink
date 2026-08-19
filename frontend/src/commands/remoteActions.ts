/// Palette entries for SSH hosts, and the connect/disconnect flows behind them.
///
/// Registered as an action source like every other feature's rows
/// (`commands/registry.ts`), so the files panel gains a remote root without
/// `App.tsx` learning anything about SSH.
///
/// Both actions end in the same picker, in two modes. Connect lists what
/// `~/.ssh/config` offers; disconnect lists what is currently open. One
/// component for both because the two lists differ only in where the rows come
/// from — a second overlay would be a second copy of the same box, which is the
/// thing `QuickPick.tsx`'s own header exists to prevent.
import { onCleanup } from "solid-js";
import { createOverlay } from "@/commands/overlay";
import { useActionSource, type Action } from "@/commands/registry";
import { pushToast } from "@/commands/toast";
import { remoteApi } from "@/api/remote";
import {
  addRemoteRoot,
  disconnectRemoteRoot,
  markRemoteRootDead,
  remoteRoots,
  type RemoteRoot,
} from "@/store/remoteRoots";

export type RemoteHostPickerMode = "connect" | "disconnect";

const hostPicker = createOverlay("remote-hosts");
let pickerMode: RemoteHostPickerMode = "connect";

export function isRemoteHostPickerOpen() {
  return hostPicker.isOpen();
}

/// Which list the picker is showing. Read once when its content mounts — the
/// picker is opened fresh each time, so there is no live mode to track.
export function remoteHostPickerMode(): RemoteHostPickerMode {
  return pickerMode;
}

export function openRemoteHostPicker(mode: RemoteHostPickerMode) {
  pickerMode = mode;
  hostPicker.open();
}

export function closeRemoteHostPicker() {
  hostPicker.close();
}

/// Connect and add the root, or explain why not. Shared by the picker and by
/// the reconnect button on a dead root in the files panel.
export async function connectRemoteHost(alias: string): Promise<boolean> {
  try {
    const conn = await remoteApi.connect(alias);
    addRemoteRoot(conn);
    pushToast(`Connected to ${conn.alias}`, "success", 2500);
    return true;
  } catch (e) {
    // Host-key and agent failures both arrive here, and both carry the one
    // sentence that says what to do about them — so the toast is long-lived
    // and unabridged rather than a summary.
    pushToast(e instanceof Error ? e.message : String(e), "error", 10000);
    return false;
  }
}

/// The files panel's "Reconnect" on a root whose session died.
export function reconnectRemoteRoot(root: RemoteRoot): Promise<boolean> {
  return connectRemoteHost(root.alias);
}

export async function disconnectRemoteHost(root: RemoteRoot): Promise<void> {
  await disconnectRemoteRoot(root.sessionId);
  pushToast(`Disconnected from ${root.alias}`, "info", 2500);
}

/// Start listening for sessions that die on their own.
///
/// Called from the same place the actions are registered, so there is exactly
/// one listener for the app's lifetime and it is torn down with the scope that
/// owns it. Not started at module load: `listen` reaches for the Tauri bridge,
/// and a module that does that on import cannot be imported by a unit test.
function watchDisconnects(): void {
  const pending = remoteApi.onDisconnected((sessionId) => {
    markRemoteRootDead(sessionId);
    pushToast("An SSH connection dropped — the root is marked in the explorer", "error", 6000);
  });
  onCleanup(() => {
    void pending.then((un) => un());
  });
}

export function registerRemoteActions(): void {
  watchDisconnects();

  useActionSource(150, (): Action[] => [
    {
      id: "remote.connect",
      label: "Connect to SSH Host…",
      description: "Browse a machine from ~/.ssh/config in the files panel",
      group: "Remote",
      run: () => openRemoteHostPicker("connect"),
    },
    {
      id: "remote.disconnect",
      label: "Disconnect SSH Host",
      description: "Close a connection and drop its root from the files panel",
      group: "Remote",
      enabled: () => remoteRoots().length > 0,
      run: () => {
        const open = remoteRoots();
        // With one host open the picker would be a list of one, which is a
        // dialog asking the user to confirm the only possible answer.
        if (open.length === 1) return disconnectRemoteHost(open[0]);
        openRemoteHostPicker("disconnect");
      },
    },
  ]);
}
