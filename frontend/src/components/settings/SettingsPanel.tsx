import { createSignal, For } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-solid";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const VIBRANCY_OPTIONS = [
  { value: "hudWindow", label: "HUD" },
  { value: "sidebar", label: "Sidebar" },
  { value: "windowBackground", label: "Window" },
  { value: "underWindowBackground", label: "Under Window" },
  { value: "off", label: "Off" },
] as const;

type VibrancyValue = (typeof VIBRANCY_OPTIONS)[number]["value"];

function readSavedOpacity(): number {
  const saved = localStorage.getItem("voidlink-opacity");
  return saved ? parseFloat(saved) : 0.85;
}

function readSavedVibrancy(): VibrancyValue {
  return (localStorage.getItem("voidlink-vibrancy") as VibrancyValue) ?? "hudWindow";
}

export function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const [opacity, setOpacity] = createSignal<number>(readSavedOpacity());
  const [vibrancy, setVibrancy] = createSignal<VibrancyValue>(readSavedVibrancy());

  const handleOpacityChange = (e: Event & { currentTarget: HTMLInputElement }) => {
    const value = parseFloat(e.currentTarget.value);
    setOpacity(value);
    document.documentElement.style.setProperty("--bg-opacity", String(value));
    localStorage.setItem("voidlink-opacity", String(value));
  };

  const handleVibrancyChange = async (value: VibrancyValue) => {
    setVibrancy(value);
    localStorage.setItem("voidlink-vibrancy", value);
    const win = getCurrentWindow();
    if (value === "off") {
      await win.clearEffects();
    } else {
      await win.setEffects({ effects: [value], state: "active" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <div class="flex items-center justify-between mb-4">
            <DialogTitle>Settings</DialogTitle>
            <DialogClose class="p-1 rounded hover:bg-accent">
              <X class="w-4 h-4" />
            </DialogClose>
          </div>

          <div class="space-y-5">
            <div>
              <label class="text-sm font-medium mb-2 block">Background Blur</label>
              <div class="flex gap-1 flex-wrap">
                <For each={VIBRANCY_OPTIONS}>
                  {(opt) => (
                    <button
                      onClick={() => handleVibrancyChange(opt.value)}
                      class={`px-3 py-1 rounded text-sm transition-colors ${
                        vibrancy() === opt.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent hover:bg-accent/80 text-accent-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  )}
                </For>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                Native macOS vibrancy material
              </p>
            </div>

            <div>
              <label class="text-sm font-medium mb-2 block">
                Background Opacity
              </label>
              <div class="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={opacity()}
                  onInput={handleOpacityChange}
                  class="flex-1 h-2 rounded-lg appearance-none cursor-pointer accent-primary"
                />
                <span class="text-sm text-muted-foreground w-10 text-right">
                  {Math.round(opacity() * 100)}%
                </span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                UI panel transparency over blur
              </p>
            </div>
          </div>

          <div class="mt-6 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
