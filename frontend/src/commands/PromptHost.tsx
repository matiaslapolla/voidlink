import { For, Show, createEffect, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { usePrompt, resolvePrompt } from "@/commands/prompt";

/// Renders the active text prompt as a centered modal. Mount once at the app
/// root (next to ToastViewport). Enter confirms, Escape / backdrop cancels.
export function PromptHost() {
  const { request } = usePrompt();
  let inputRef: HTMLInputElement | undefined;
  const [toggleState, setToggleState] = createSignal<Record<string, boolean>>({});

  // Focus + preselect whenever a new request appears; seed toggle defaults.
  createEffect(() => {
    const r = request();
    if (r) {
      setToggleState(
        Object.fromEntries(r.toggles.map((t) => [t.key, t.default ?? false])),
      );
      queueMicrotask(() => { inputRef?.focus(); inputRef?.select(); });
    }
  });

  const confirm = () => resolvePrompt(inputRef?.value ?? "", toggleState());

  return (
    <Show when={request()}>
      {(r) => (
        <Portal>
          <div
            class="fixed inset-0 z-[var(--z-prompt)] flex items-start justify-center bg-black/40 pt-[20vh]"
            onClick={() => resolvePrompt(null)}
          >
            <div
              class="w-[min(420px,90vw)] bg-elev-3 border border-border rounded-lg shadow-xl p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 class="text-title font-semibold text-foreground mb-2">{r().title}</h2>
              <Show when={r().label}>
                <p class="text-body text-muted-foreground mb-2">{r().label}</p>
              </Show>
              <input
                ref={inputRef}
                value={r().initialValue}
                placeholder={r().placeholder}
                spellcheck={false}
                autocapitalize="off"
                autocorrect="off"
                class="w-full bg-input/60 border border-border rounded px-2 py-1.5 text-ui text-foreground outline-none focus:border-primary"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); confirm(); }
                  else if (e.key === "Escape") { e.preventDefault(); resolvePrompt(null); }
                }}
              />
              <Show when={r().toggles.length > 0}>
                <div class="mt-3 space-y-1.5">
                  <For each={r().toggles}>
                    {(t) => (
                      <label class="flex items-center gap-2 text-body text-foreground cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={toggleState()[t.key] ?? false}
                          onChange={(e) =>
                            setToggleState((s) => ({ ...s, [t.key]: e.currentTarget.checked }))
                          }
                          class="accent-primary"
                        />
                        {t.label}
                      </label>
                    )}
                  </For>
                </div>
              </Show>
              <div class="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => resolvePrompt(null)}
                  class="px-3 py-1.5 rounded text-body text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirm}
                  class="px-3 py-1.5 rounded text-body bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  {r().confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
