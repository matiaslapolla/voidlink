/// The SSH host list, in the chrome every other picker in voidlink wears.
///
/// Two modes over one component (see `remoteActions.ts`): `connect` lists the
/// aliases in `~/.ssh/config`, `disconnect` lists the roots currently open. The
/// rows differ; the box, the fuzzy match and the empty state do not.
///
/// Aliases needing a `ProxyJump` are listed with the reason they will fail
/// rather than filtered out. A host missing from the list reads as a broken
/// config file, which sends the user to fix something that is not wrong.
import { Show, createMemo, createResource, createSignal } from "solid-js";
import { Server, Unplug } from "lucide-solid";
import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import {
  closeRemoteHostPicker,
  connectRemoteHost,
  disconnectRemoteHost,
  isRemoteHostPickerOpen,
  remoteHostPickerMode,
} from "@/commands/remoteActions";
import { remoteApi, type RemoteHost } from "@/api/remote";
import { remoteRoots, type RemoteRoot } from "@/store/remoteRoots";

export function RemoteHostPicker() {
  return (
    <Show when={isRemoteHostPickerOpen()}>
      <PickerContent />
    </Show>
  );
}

/// One row, mode-independent: an id to key on, the text searched, and the note
/// shown on the right (what the alias resolves to, or why it will not connect).
interface Row {
  id: string;
  label: string;
  note: string;
  /// A reason this row cannot do its job. Rendered as a warning rather than
  /// disabling the row — the connect attempt reports the same thing with more
  /// detail, and a row you cannot press cannot teach you that.
  warning?: string;
  ranges: MatchRange[];
  score: number;
  /// The row's action. Return value is ignored — `connectRemoteHost` reports
  /// success as a boolean for its other caller, and the picker has nothing to
  /// do with it beyond closing.
  run: () => unknown;
}

function PickerContent() {
  const mode = remoteHostPickerMode();
  const [query, setQuery] = createSignal("");
  // Only fetched in connect mode; the open-roots list is already in memory.
  const [hosts] = createResource<RemoteHost[]>(
    () => (mode === "connect" ? remoteApi.hosts() : Promise.resolve([])),
  );

  const rows = createMemo<Row[]>(() => {
    const q = query().trim();
    const candidates: Omit<Row, "ranges" | "score">[] =
      mode === "connect" ? connectRows(hosts() ?? []) : disconnectRows(remoteRoots());

    const out: Row[] = [];
    for (const c of candidates) {
      const match = bestFuzzyMatch([c.label, c.note], q, { pathAware: false });
      if (!match) continue;
      out.push({
        ...c,
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }
    return q ? out.sort((a, b) => b.score - a.score) : out;
  });

  function pick(row: Row) {
    closeRemoteHostPicker();
    row.run();
  }

  return (
    <QuickPick
      items={rows()}
      itemKey={(row) => row.id}
      query={query()}
      onQuery={setQuery}
      onPick={pick}
      onClose={closeRemoteHostPicker}
      loading={mode === "connect" && hosts.loading}
      loadingLabel="Reading ~/.ssh/config…"
      label={mode === "connect" ? "Connect to SSH host" : "Disconnect SSH host"}
      placeholder={
        mode === "connect" ? "Connect to a host from ~/.ssh/config…" : "Disconnect a host…"
      }
      empty={
        <QuickPickEmpty
          icon={mode === "connect" ? <Server class="w-5 h-5" /> : <Unplug class="w-5 h-5" />}
          message={
            mode === "connect"
              ? "No host in ~/.ssh/config matches that."
              : "No open connection matches that."
          }
          hint={
            mode === "connect"
              ? "Aliases come from Host entries in ~/.ssh/config."
              : "Connect to a host first."
          }
        />
      }
      renderItem={(row, highlighted) => <HostRow row={row} highlighted={highlighted()} />}
    />
  );
}

function connectRows(hosts: RemoteHost[]): Omit<Row, "ranges" | "score">[] {
  return hosts.map((h) => ({
    id: h.alias,
    label: h.alias,
    note: `${h.user}@${h.hostname}${h.port === 22 ? "" : `:${h.port}`}`,
    warning: h.proxyJump ? `via ${h.proxyJump} — not supported yet` : undefined,
    run: () => connectRemoteHost(h.alias),
  }));
}

function disconnectRows(roots: RemoteRoot[]): Omit<Row, "ranges" | "score">[] {
  return roots.map((r) => ({
    id: r.sessionId,
    label: r.alias,
    note: r.homeDir,
    warning: r.dead ? "connection already lost" : undefined,
    run: () => disconnectRemoteHost(r),
  }));
}

function HostRow(props: { row: Row; highlighted: boolean }) {
  return (
    <QuickPickRow highlighted={props.highlighted}>
      <Server class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <FuzzyText text={props.row.label} ranges={props.row.ranges} class="truncate font-mono" />
      <span class="ml-auto shrink-0 flex items-center gap-2 text-micro">
        <Show when={props.row.warning}>
          {(w) => <span class="text-warning">⚠ {w()}</span>}
        </Show>
        <span class="text-muted-foreground/70 font-mono truncate max-w-[220px]">
          {props.row.note}
        </span>
      </span>
    </QuickPickRow>
  );
}
