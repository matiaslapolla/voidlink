/// One quiet line above a diff, saying who probably wrote it.
///
/// ## Why it is a line of prose and not a signal
///
/// §7.5.3's activity vocabulary is a closed set of LEDs, and every member of it
/// means *something happened that you should look at*. Provenance is the
/// opposite: it is context for something the reader is already looking at, and
/// nothing about it is news. Adding a dot for it would both invent a second
/// status shape (§11) and overstate the urgency of a fact that is, at best, a
/// good guess. So it renders as muted text at the top of the diff body, in the
/// same register as the hunk header's `@@ … @@`.
///
/// ## Why the hedge is in the visible text and not only the tooltip
///
/// The attribution is inferred from overlapping time, never observed — see
/// `provenance.ts`. A chip reading "Refactorer" with the caveat hidden behind
/// hover is a chip that will be read as a fact, because most readers never
/// hover and none of them hover on a phone screenshot pasted into a review. So
/// the visible string carries the hedge ("Probably"), the resolution of the
/// claim ("this whole file, not these lines") and the `inferred` marker — the
/// same marker the timeline uses for the same reason. The tooltip only expands
/// on what is already said.

import { Show } from "solid-js";
import { Bot } from "lucide-solid";
import { explainProvenance, type Provenance } from "./provenance";

/// What the claim actually covers, said in the row itself.
///
/// Naming the scope in the *visible* text is what stops a file-level guess from
/// being read as a statement about the lines underneath it, which is the one
/// misreading this surface exists to prevent.
function scopeLine(provenance: Provenance): string {
  return provenance.scope === "commit"
    ? "this whole commit, not these lines"
    : "this whole file, not these lines";
}

export function ProvenanceNote(props: { provenance: Provenance | null | undefined }) {
  return (
    // No evidence renders as nothing at all. An "unknown" row would put a
    // permanent strip above every diff in a repository no agent has ever
    // touched, to say that nothing is known — which is the reader's default
    // assumption already.
    <Show when={props.provenance}>
      {(provenance) => (
        <p
          class="flex items-center gap-1.5 px-3 py-1 border-b border-border bg-muted/20 text-[10px] text-muted-foreground"
          title={explainProvenance(provenance())}
        >
          <Bot class="w-2.5 h-2.5 shrink-0 opacity-70" aria-hidden="true" />
          <span class="min-w-0 truncate">
            Probably <span class="text-foreground/80">{provenance().agent}</span>
            {" — "}
            {scopeLine(provenance())}
          </span>
          <span class="ml-auto shrink-0 px-1 rounded bg-muted">inferred</span>
          {/* The tooltip is not reachable without a pointer, and this claim is
              exactly the kind a reader must not receive in its short form
              only. */}
          <span class="sr-only">{explainProvenance(provenance())}</span>
        </p>
      )}
    </Show>
  );
}
