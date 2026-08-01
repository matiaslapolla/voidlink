import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { AlertTriangle, Check, Loader2, X } from "lucide-solid";
import { gitApi } from "@/api/git";
import { terminalApi } from "@/api/terminal";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import {
  WORKTREE_DIR,
  classifyWorktreeBranch,
  clearNewWorktreeRequest,
  defaultWorktreePath,
  newWorktreeRequest,
  type NewWorktreeRequest,
} from "@/commands/worktree";
import { fsApi } from "@/api/fs";
import type { DepAction, SetupStep, WorktreeSetupPlan } from "@/types/git";

const DEP_ACTIONS: { value: DepAction; label: string; hint: string }[] = [
  { value: "symlink", label: "Symlink", hint: "Instant. Both worktrees share one directory." },
  { value: "copy", label: "Copy", hint: "Slower, but the two worktrees can diverge." },
  { value: "install", label: "Run install", hint: "Added to the post-create command." },
  { value: "skip", label: "Skip", hint: "Leave it out entirely." },
];

type Step = "branch" | "env" | "deps" | "result";

/// Host for the new-worktree wizard. Mounted once at the app root and driven
/// by the module-level request signal in `commands/worktree.ts`, so the rail,
/// the ⌘K palette and the git sidebar can all open it without importing it.
export function NewWorktreeWizard() {
  return (
    <Show when={newWorktreeRequest()} keyed>
      {(request) => <WizardBody request={request} />}
    </Show>
  );
}

function WizardBody(props: { request: NewWorktreeRequest }) {
  const { actions } = useAppStore();

  const [step, setStep] = createSignal<Step>("branch");
  const [branch, setBranch] = createSignal("");
  const [path, setPath] = createSignal("");
  const [pathTouched, setPathTouched] = createSignal(false);
  const [selectedEnv, setSelectedEnv] = createSignal<Set<string>>(new Set());
  const [depActions, setDepActions] = createSignal<Record<string, DepAction>>({});
  const [postCreate, setPostCreate] = createSignal("");
  const [saveDefaults, setSaveDefaults] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [steps, setSteps] = createSignal<SetupStep[]>([]);
  const [createdPath, setCreatedPath] = createSignal<string | null>(null);

  const [plan] = createResource<WorktreeSetupPlan>(() =>
    gitApi.worktreeSetupPlan(props.request.repoRoot, props.request.sourcePath),
  );

  /// Remotes included. Listing locals only is what made a remote-only branch
  /// read as new — see `classifyWorktreeBranch`. Fetched once when the wizard
  /// opens so step 1 can say what the name will do *before* the user commits
  /// to it, rather than the classification happening invisibly on Create.
  const [allBranches] = createResource(() =>
    gitApi.listBranches(props.request.repoRoot, true),
  );

  const branchKind = () =>
    classifyWorktreeBranch(branch(), allBranches() ?? []);

  // Seed the answers from the repo's saved defaults the moment the plan lands,
  // so a repeat worktree in the same repo really is one confirm click.
  const applyPlanDefaults = (p: WorktreeSetupPlan) => {
    const saved = p.defaults;
    const env = new Set<string>(
      saved
        ? saved.envFiles.filter((rel) => p.envFiles.some((c) => c.relPath === rel))
        : p.envFiles.filter((c) => c.gitignored).map((c) => c.relPath),
    );
    setSelectedEnv(env);
    const deps: Record<string, DepAction> = {};
    for (const d of p.depDirs) deps[d.dir] = saved?.depActions?.[d.dir] ?? d.defaultAction;
    setDepActions(deps);
    setPostCreate(saved?.postCreateCommand ?? p.suggestedPostCreate);
  };

  let seeded = false;
  const ensureSeeded = () => {
    const p = plan();
    if (p && !seeded) {
      seeded = true;
      applyPlanDefaults(p);
    }
    return p;
  };

  const effectivePath = () => {
    if (pathTouched()) return path();
    const b = branch().trim();
    return b ? defaultWorktreePath(props.request.repoRoot, b) : "";
  };

  // Tracks the ignore fix locally so the banner can disappear without
  // refetching the whole plan (which would re-seed every answer).
  const [ignoreFixed, setIgnoreFixed] = createSignal(false);

  /// Append `.worktrees/` to the repository's `.gitignore`.
  ///
  /// Only offered when the default in-repo path is actually in use — if the
  /// user pointed the worktree somewhere else, the ignore rule is irrelevant.
  async function addWorktreesToGitignore() {
    const file = `${props.request.repoRoot.replace(/\/+$/, "")}/.gitignore`;
    try {
      let body = "";
      try {
        body = await fsApi.readFile(file);
      } catch {
        // No .gitignore yet — creating one with just this rule is correct.
      }
      const needsNewline = body.length > 0 && !body.endsWith("\n");
      await fsApi.writeFile(
        file,
        `${body}${needsNewline ? "\n" : ""}\n# Worktrees created by voidlink\n${WORKTREE_DIR}/\n`,
      );
      setIgnoreFixed(true);
      pushToast(`Added ${WORKTREE_DIR}/ to .gitignore`, "success");
    } catch (e) {
      pushToast(
        `Could not update .gitignore: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  }

  /// The banner shows only when all three are true: the repo does not ignore
  /// `.worktrees/`, we have not just fixed it, and the path in the box is
  /// still inside `.worktrees/`.
  const needsIgnoreWarning = (p: WorktreeSetupPlan) =>
    !p.worktreesGitignored &&
    !ignoreFixed() &&
    effectivePath().includes(`/${WORKTREE_DIR}/`);

  function cancel() {
    if (busy()) return;
    clearNewWorktreeRequest();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  function toggleEnv(rel: string) {
    setSelectedEnv((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  /// Create the worktree, then set it up. Failures are reported by stage:
  /// if `git worktree add` fails nothing was created, but if it succeeded and
  /// setup failed the directory exists and the user needs to know which half
  /// worked. We never swallow either.
  async function create() {
    const p = plan();
    if (!p) return;
    const branchName = branch().trim();
    const destPath = effectivePath().trim();
    if (!branchName || !destPath) {
      setError("A branch name and a path are both required.");
      return;
    }
    setBusy(true);
    setError(null);

    let created;
    try {
      // Re-listed rather than reusing the resource: the wizard can sit open for
      // minutes, and a fetch or a colleague's push in that window changes the
      // answer. `newBranch` is false for both `local` and `remote` — for
      // `remote`, git's own DWIM turns `worktree add <path> <branch>` into a
      // tracking branch, which is the whole point.
      const existing = await gitApi.listBranches(props.request.repoRoot, true);
      const isNew = classifyWorktreeBranch(branchName, existing).kind === "new";
      created = await gitApi.addWorktree(props.request.repoRoot, destPath, branchName, isNew);
    } catch (e) {
      setBusy(false);
      setError(
        `Nothing was created. ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    setCreatedPath(created.path);
    emitGitRefsChanged();

    // From here the worktree exists on disk. Everything below is best-effort
    // and reported step by step — we do not roll the worktree back.
    let pending: string[] = [];
    try {
      const report = await gitApi.worktreeApplySetup({
        sourcePath: props.request.sourcePath,
        destPath: created.path,
        envFiles: [...selectedEnv()],
        depActions: depActions(),
      });
      setSteps(report.steps);
      pending = report.pendingCommands;
    } catch (e) {
      setSteps([
        {
          label: "worktree setup",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
      ]);
    }

    if (saveDefaults()) {
      try {
        await gitApi.worktreeSaveDefaults(props.request.repoRoot, {
          envFiles: [...selectedEnv()],
          depActions: depActions(),
          postCreateCommand: postCreate(),
          warnedNotGitignored: true,
        });
      } catch (e) {
        setSteps((s) => [
          ...s,
          {
            label: "save defaults to .voidlink/worktree.json",
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        ]);
      }
    }

    // Register it in the rail and make it active, so the terminal we spawn
    // next lands in the right worktree.
    const wtId = actions.addWorktree(props.request.workspaceId, {
      path: created.path,
      branch: created.branch,
      isMain: false,
    });
    if (wtId) actions.selectWorktree(wtId);

    // Post-create command runs in a real terminal tab so its output streams.
    const commands = [postCreate().trim(), ...pending].filter(
      (c, i, all) => c.length > 0 && all.indexOf(c) === i,
    );
    if (wtId && commands.length > 0) {
      try {
        const termId = await actions.spawnTerminal(wtId);
        const session = termId
          ? actions.findTerminal(wtId, termId)
          : null;
        if (session) {
          await terminalApi.writePty(session.ptyId, `${commands.join(" && ")}\n`);
        } else {
          setSteps((s) => [
            ...s,
            {
              label: "run post-create command",
              ok: false,
              error: "Could not open a terminal in the new worktree.",
            },
          ]);
        }
      } catch (e) {
        setSteps((s) => [
          ...s,
          {
            label: "run post-create command",
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        ]);
      }
    }

    setBusy(false);
    setStep("result");
    const failed = steps().filter((s) => !s.ok).length;
    if (failed === 0) pushToast(`Worktree ${branchName} is ready`, "success", 3000);
  }

  const failedSteps = () => steps().filter((s) => !s.ok);

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[var(--z-wizard)] bg-black/40 flex items-start justify-center pt-[12vh]"
        onClick={(e) => {
          if (e.target === e.currentTarget) cancel();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New worktree"
          class="w-[560px] max-w-[92vw] max-h-[76vh] flex flex-col rounded-lg border border-border bg-elev-3 text-popover-foreground shadow-xl"
        >
          {/* Header */}
          <div class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border">
            <div class="flex-1 min-w-0">
              <h2 class="text-sm font-semibold">New worktree</h2>
              <p class="text-[11px] text-muted-foreground truncate">
                {props.request.repoRoot}
              </p>
            </div>
            <button
              onClick={cancel}
              disabled={busy()}
              aria-label="Cancel"
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"
            >
              <X class="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 text-[13px]">
            <Show
              when={ensureSeeded()}
              fallback={
                <Show
                  when={!plan.error}
                  fallback={
                    <p class="text-destructive text-[12px]">
                      Could not inspect the repository: {String(plan.error)}
                    </p>
                  }
                >
                  <div class="flex items-center gap-2 text-muted-foreground py-6 justify-center">
                    <Loader2 class="w-4 h-4 animate-spin" />
                    Inspecting the repository…
                  </div>
                </Show>
              }
            >
              {(p) => (
                <>
                  {/* Step 1 — branch + path */}
                  <Show when={step() === "branch"}>
                    <label class="block text-[11px] text-muted-foreground mb-1">
                      Branch for the worktree (existing or new)
                    </label>
                    <input
                      value={branch()}
                      autofocus
                      placeholder="feature/my-branch"
                      onInput={(e) => setBranch(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && branch().trim()) setStep("env");
                      }}
                      class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    {/* What the name resolves to, said where the name is
                        typed. The classification decides whether a branch is
                        created or checked out, and it used to happen silently
                        on Create. */}
                    <Show when={branch().trim() && !allBranches.loading}>
                      <p class="text-[11px] text-muted-foreground mt-1">
                        <Show when={branchKind().kind === "local"}>
                          Checks out the existing branch{" "}
                          <span class="font-mono">{branch().trim()}</span>.
                        </Show>
                        <Show when={branchKind().kind === "remote"}>
                          Creates <span class="font-mono">{branch().trim()}</span> tracking{" "}
                          <span class="font-mono">{branchKind().trackingRef}</span>.
                        </Show>
                        <Show when={branchKind().kind === "new"}>
                          Creates a new branch{" "}
                          <span class="font-mono">{branch().trim()}</span> from the current HEAD.
                        </Show>
                      </p>
                    </Show>
                    <label class="block text-[11px] text-muted-foreground mt-3 mb-1">
                      Directory
                    </label>
                    <input
                      value={effectivePath()}
                      placeholder="Derived from the branch name"
                      onInput={(e) => {
                        setPathTouched(true);
                        setPath(e.currentTarget.value);
                      }}
                      class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <p class="text-[11px] text-muted-foreground mt-1">
                      Defaults to {WORKTREE_DIR}/ inside the repository.
                    </p>
                    <Show when={needsIgnoreWarning(p())}>
                      <div class="mt-2 flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                        <AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-px" />
                        <div class="flex-1">
                          <p>
                            {WORKTREE_DIR}/ isn't in this repository's ignore rules, so
                            the new worktree would show up as untracked files.
                          </p>
                          <button
                            onClick={() => void addWorktreesToGitignore()}
                            class="mt-1 underline underline-offset-2 hover:text-foreground transition-colors"
                          >
                            Add {WORKTREE_DIR}/ to .gitignore
                          </button>
                        </div>
                      </div>
                    </Show>
                    <Show when={p().defaults}>
                      <p class="text-[11px] text-muted-foreground mt-3">
                        Using this repository's saved answers — review them on the next
                        steps or create now.
                      </p>
                    </Show>
                  </Show>

                  {/* Step 2 — env files */}
                  <Show when={step() === "env"}>
                    <Show
                      when={p().envFiles.length > 0}
                      fallback={
                        <p class="text-muted-foreground text-[12px]">
                          No <span class="font-mono">.env</span> files found in the source
                          worktree.
                        </p>
                      }
                    >
                      <p class="text-[11px] text-muted-foreground mb-2">
                        Gitignored env files never reach a fresh worktree. Pick the ones to
                        copy across.
                      </p>
                      <For each={p().envFiles}>
                        {(file) => (
                          <label class="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent/30 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedEnv().has(file.relPath)}
                              onChange={() => toggleEnv(file.relPath)}
                            />
                            <span class="font-mono text-[12px] flex-1 truncate">
                              {file.relPath}
                            </span>
                            <Show
                              when={file.gitignored}
                              fallback={
                                <span class="text-[10px] text-muted-foreground">
                                  tracked
                                </span>
                              }
                            >
                              <span class="text-[10px] text-warning">gitignored</span>
                            </Show>
                            <span class="text-[10px] text-muted-foreground tabular-nums">
                              {file.size} b
                            </span>
                          </label>
                        )}
                      </For>
                    </Show>
                  </Show>

                  {/* Step 3 — dependencies + post-create */}
                  <Show when={step() === "deps"}>
                    <Show
                      when={p().depDirs.length > 0}
                      fallback={
                        <p class="text-muted-foreground text-[12px]">
                          No lockfiles detected — nothing to set up.
                        </p>
                      }
                    >
                      <For each={p().depDirs}>
                        {(dep) => (
                          <div class="mb-3">
                            <div class="flex items-baseline gap-2">
                              <span class="font-mono text-[12px]">{dep.dir}</span>
                              <span class="text-[11px] text-muted-foreground">
                                {dep.manager} · from {dep.detectedFrom}
                              </span>
                              <Show when={!dep.existsInSource}>
                                <span class="text-[10px] text-muted-foreground">
                                  not present in source
                                </span>
                              </Show>
                            </div>
                            <div class="flex flex-wrap gap-1.5 mt-1">
                              <For each={DEP_ACTIONS}>
                                {(opt) => {
                                  const unavailable = () =>
                                    (opt.value === "symlink" || opt.value === "copy") &&
                                    !dep.existsInSource;
                                  return (
                                    <button
                                      onClick={() =>
                                        setDepActions((prev) => ({
                                          ...prev,
                                          [dep.dir]: opt.value,
                                        }))
                                      }
                                      disabled={unavailable()}
                                      title={
                                        unavailable()
                                          ? `${dep.dir} does not exist in the source worktree`
                                          : opt.hint
                                      }
                                      class={`px-2 py-0.5 rounded border text-[11px] transition-colors ${
                                        depActions()[dep.dir] === opt.value
                                          ? "border-primary bg-primary/15 text-foreground"
                                          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                                      } ${unavailable() ? "opacity-40 cursor-not-allowed" : ""}`}
                                    >
                                      {opt.label}
                                    </button>
                                  );
                                }}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>

                    <label class="block text-[11px] text-muted-foreground mt-4 mb-1">
                      Post-create command (runs in a terminal in the new worktree)
                    </label>
                    <input
                      value={postCreate()}
                      placeholder="pnpm install"
                      onInput={(e) => setPostCreate(e.currentTarget.value)}
                      class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
                    />

                    <label class="flex items-center gap-2 mt-3 text-[12px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={saveDefaults()}
                        onChange={(e) => setSaveDefaults(e.currentTarget.checked)}
                      />
                      Remember these answers for this repository
                    </label>
                    {/* Warn once per repo: after the first save we record that
                        the user has seen this, so it doesn't nag on every
                        worktree. */}
                    <Show
                      when={
                        saveDefaults() &&
                        !p().voidlinkGitignored &&
                        !p().defaults?.warnedNotGitignored
                      }
                    >
                      <p class="flex items-start gap-1.5 text-[11px] text-warning mt-1.5">
                        <AlertTriangle class="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          <span class="font-mono">.voidlink/</span> is not gitignored — these
                          answers would be committed. Add it to{" "}
                          <span class="font-mono">.gitignore</span> first if that isn't what
                          you want.
                        </span>
                      </p>
                    </Show>
                  </Show>

                  {/* Result */}
                  <Show when={step() === "result"}>
                    <p class="text-[12px] mb-2">
                      Created <span class="font-mono">{createdPath()}</span> on{" "}
                      <span class="font-mono">{branch()}</span>.
                    </p>
                    <For each={steps()}>
                      {(s) => (
                        <div class="flex items-start gap-2 py-0.5">
                          <Show
                            when={s.ok}
                            fallback={<X class="w-3 h-3 mt-1 shrink-0 text-destructive" />}
                          >
                            <Check class="w-3 h-3 mt-1 shrink-0 text-success" />
                          </Show>
                          <div class="min-w-0">
                            <div class="text-[12px]">{s.label}</div>
                            <Show when={s.error}>
                              <div class="text-[11px] text-destructive break-words">
                                {s.error}
                              </div>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                    <Show when={failedSteps().length > 0}>
                      <p class="text-[11px] text-warning mt-3">
                        The worktree itself was created. {failedSteps().length} setup step
                        {failedSteps().length === 1 ? "" : "s"} did not complete — fix them in
                        the new worktree's terminal.
                      </p>
                    </Show>
                  </Show>

                  <Show when={error()}>
                    <p class="text-[12px] text-destructive mt-3">{error()}</p>
                  </Show>
                </>
              )}
            </Show>
          </div>

          {/* Footer */}
          <div class="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border">
            <div class="flex-1 text-[11px] text-muted-foreground">
              <Show when={step() !== "result"}>
                Step {step() === "branch" ? 1 : step() === "env" ? 2 : 3} of 3
              </Show>
            </div>
            <Show when={step() === "result"}>
              <button
                onClick={() => clearNewWorktreeRequest()}
                class="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Done
              </button>
            </Show>
            <Show when={step() !== "result"}>
              <button
                onClick={cancel}
                disabled={busy()}
                class="px-3 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"
              >
                Cancel
              </button>
              <Show when={step() !== "branch"}>
                <button
                  onClick={() => setStep(step() === "deps" ? "env" : "branch")}
                  disabled={busy()}
                  class="px-3 py-1 rounded text-[12px] border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"
                >
                  Back
                </button>
              </Show>
              <Show
                when={step() === "deps"}
                fallback={
                  <button
                    onClick={() => setStep(step() === "branch" ? "env" : "deps")}
                    disabled={busy() || !plan() || (step() === "branch" && !branch().trim())}
                    class="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                  >
                    Next
                  </button>
                }
              >
                <button
                  onClick={() => void create()}
                  disabled={busy() || !branch().trim()}
                  class="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Show when={busy()}>
                    <Loader2 class="w-3 h-3 animate-spin" />
                  </Show>
                  Create worktree
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
