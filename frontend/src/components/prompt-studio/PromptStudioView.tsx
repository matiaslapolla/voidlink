import { createSignal, createEffect, Show, For, createMemo, onMount } from "solid-js";
import {
  Plus,
  Search,
  Star,
  Trash2,
  Play,
  Wand2,
  BarChart3,
  History,
  Tag,
  Copy,
  Check,
  X,
  ThumbsUp,
  ThumbsDown,
  Variable,
  Sparkles,
} from "lucide-solid";
import { promptStudioApi } from "@/api/prompt-studio";
import type {
  PromptSummary,
  PromptFull,
  PromptExecution,
  PromptAnalysis,
  OptimizeResult,
  PromptVersion,
  SaveVariableInput,
} from "@/types/prompt-studio";

type RightPanel = "variables" | "analysis" | "history" | "executions";

export function PromptStudioView() {
  // ─── Library state ───────────────────────────────────────────────────────
  const [prompts, setPrompts] = createSignal<PromptSummary[]>([]);
  const [filterText, setFilterText] = createSignal("");
  const [filterTag, setFilterTag] = createSignal<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = createSignal(false);
  const [allTags, setAllTags] = createSignal<string[]>([]);

  // ─── Editor state ────────────────────────────────────────────────────────
  const [activePrompt, setActivePrompt] = createSignal<PromptFull | null>(null);
  const [editName, setEditName] = createSignal("");
  const [editDescription, setEditDescription] = createSignal("");
  const [editContent, setEditContent] = createSignal("");
  const [editSystemPrompt, setEditSystemPrompt] = createSignal("");
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editVariables, setEditVariables] = createSignal<SaveVariableInput[]>([]);
  const [newTagInput, setNewTagInput] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  // ─── Right panel state ───────────────────────────────────────────────────
  const [rightPanel, setRightPanel] = createSignal<RightPanel>("variables");
  const [variableValues, setVariableValues] = createSignal<Record<string, string>>({});
  const [executing, setExecuting] = createSignal(false);
  const [executions, setExecutions] = createSignal<PromptExecution[]>([]);
  const [versions, setVersions] = createSignal<PromptVersion[]>([]);
  const [analysis, setAnalysis] = createSignal<PromptAnalysis | null>(null);
  const [analyzing, setAnalyzing] = createSignal(false);
  const [optimizeResult, setOptimizeResult] = createSignal<OptimizeResult | null>(null);
  const [optimizing, setOptimizing] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  // ─── Data loading ────────────────────────────────────────────────────────

  const loadPrompts = async () => {
    try {
      const list = await promptStudioApi.list();
      setPrompts(list);
      const tags = await promptStudioApi.listTags();
      setAllTags(tags.map((t) => t.name));
    } catch (e) {
      console.error("Failed to load prompts:", e);
    }
  };

  onMount(loadPrompts);

  const loadPromptDetails = async (id: string) => {
    try {
      const full = await promptStudioApi.get(id);
      setActivePrompt(full);
      setEditName(full.name);
      setEditDescription(full.description);
      setEditContent(full.content);
      setEditSystemPrompt(full.systemPrompt);
      setEditTags([...full.tags]);
      setEditVariables(
        full.variables.map((v) => ({
          name: v.name,
          varType: v.varType,
          defaultValue: v.defaultValue,
          description: v.description,
          required: v.required,
        })),
      );
      setDirty(false);
      setAnalysis(null);
      setOptimizeResult(null);

      // Initialize variable values with defaults
      const vals: Record<string, string> = {};
      for (const v of full.variables) {
        vals[v.name] = v.defaultValue || "";
      }
      setVariableValues(vals);

      // Load executions
      promptStudioApi.getExecutions(id, 10).then(setExecutions).catch(console.error);
      promptStudioApi.getVersions(id).then(setVersions).catch(console.error);
    } catch (e) {
      console.error("Failed to load prompt:", e);
    }
  };

  // ─── Filtered list ─────────────────────────────────────────────────────

  const filteredPrompts = createMemo(() => {
    let list = prompts();
    const q = filterText().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (showFavoritesOnly()) {
      list = list.filter((p) => p.isFavorite);
    }
    const tag = filterTag();
    if (tag) {
      list = list.filter((p) => p.tags.includes(tag));
    }
    return list;
  });

  // ─── Detected variables from content ───────────────────────────────────

  const detectedVars = createMemo(() => {
    const content = editContent();
    const system = editSystemPrompt();
    const text = content + " " + system;
    const vars: string[] = [];
    const regex = /\{\{(\w+)(?::[^}]*)?\}\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!vars.includes(match[1])) vars.push(match[1]);
    }
    return vars;
  });

  // Sync detected variables with edit variables
  createEffect(() => {
    const detected = detectedVars();
    const current = editVariables();
    const currentNames = new Set(current.map((v) => v.name));
    let changed = false;
    const updated = [...current];

    for (const name of detected) {
      if (!currentNames.has(name)) {
        updated.push({ name, varType: "text", defaultValue: "", description: "", required: true });
        changed = true;
      }
    }

    if (changed) {
      setEditVariables(updated);
      setDirty(true);
    }
  });

  // ─── CRUD actions ──────────────────────────────────────────────────────

  const createPrompt = async () => {
    try {
      const result = await promptStudioApi.save({
        name: "New Prompt",
        content: "{{input}}",
        variables: [{ name: "input", varType: "text", defaultValue: "", description: "User input" }],
      });
      await loadPrompts();
      await loadPromptDetails(result.id);
    } catch (e) {
      console.error("Failed to create prompt:", e);
    }
  };

  const savePrompt = async () => {
    const prompt = activePrompt();
    if (!prompt) return;
    setSaving(true);
    try {
      const result = await promptStudioApi.save({
        id: prompt.id,
        name: editName(),
        description: editDescription(),
        content: editContent(),
        systemPrompt: editSystemPrompt(),
        variables: editVariables(),
        tags: editTags(),
      });
      setActivePrompt(result);
      setDirty(false);
      await loadPrompts();
      promptStudioApi.getVersions(prompt.id).then(setVersions).catch(console.error);
    } catch (e) {
      console.error("Failed to save prompt:", e);
    } finally {
      setSaving(false);
    }
  };

  const deletePrompt = async (id: string) => {
    try {
      await promptStudioApi.delete(id);
      if (activePrompt()?.id === id) {
        setActivePrompt(null);
      }
      await loadPrompts();
    } catch (e) {
      console.error("Failed to delete prompt:", e);
    }
  };

  const toggleFavorite = async (id: string) => {
    try {
      await promptStudioApi.toggleFavorite(id);
      await loadPrompts();
      if (activePrompt()?.id === id) {
        const p = activePrompt()!;
        setActivePrompt({ ...p, isFavorite: !p.isFavorite });
      }
    } catch (e) {
      console.error("Failed to toggle favorite:", e);
    }
  };

  // ─── Execute ───────────────────────────────────────────────────────────

  const executePrompt = async () => {
    const prompt = activePrompt();
    if (!prompt) return;
    if (dirty()) await savePrompt();
    setExecuting(true);
    try {
      const exec = await promptStudioApi.execute({
        promptId: prompt.id,
        variables: variableValues(),
      });
      setExecutions((prev) => [exec, ...prev]);
      setRightPanel("executions");
    } catch (e) {
      console.error("Failed to execute prompt:", e);
    } finally {
      setExecuting(false);
    }
  };

  // ─── Analyze ───────────────────────────────────────────────────────────

  const analyzePrompt = async () => {
    setAnalyzing(true);
    try {
      const result = await promptStudioApi.analyze(editContent(), editSystemPrompt() || undefined);
      setAnalysis(result);
      setRightPanel("analysis");
    } catch (e) {
      console.error("Failed to analyze:", e);
    } finally {
      setAnalyzing(false);
    }
  };

  // ─── Optimize ──────────────────────────────────────────────────────────

  const optimizePrompt = async () => {
    setOptimizing(true);
    try {
      const result = await promptStudioApi.optimize(editContent(), editSystemPrompt() || undefined);
      setOptimizeResult(result);
      setRightPanel("analysis");
    } catch (e) {
      console.error("Failed to optimize:", e);
    } finally {
      setOptimizing(false);
    }
  };

  const applyOptimization = () => {
    const result = optimizeResult();
    if (result) {
      setEditContent(result.optimized);
      setDirty(true);
      setOptimizeResult(null);
    }
  };

  // ─── Tag management ────────────────────────────────────────────────────

  const addTag = () => {
    const tag = newTagInput().trim();
    if (tag && !editTags().includes(tag)) {
      setEditTags((prev) => [...prev, tag]);
      setNewTagInput("");
      setDirty(true);
    }
  };

  const removeTag = (tag: string) => {
    setEditTags((prev) => prev.filter((t) => t !== tag));
    setDirty(true);
  };

  // ─── Copy rendered prompt ──────────────────────────────────────────────

  const copyRendered = () => {
    let rendered = editContent();
    const vars = variableValues();
    for (const [name, value] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{{${name}}}`, value);
    }
    navigator.clipboard.writeText(rendered);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Rate execution ────────────────────────────────────────────────────

  const rateExecution = async (execId: string, rating: number) => {
    try {
      await promptStudioApi.rateExecution(execId, rating);
      setExecutions((prev) =>
        prev.map((e) => (e.id === execId ? { ...e, rating } : e)),
      );
    } catch (e) {
      console.error("Failed to rate:", e);
    }
  };

  // ─── Token estimate ────────────────────────────────────────────────────

  const tokenEstimate = createMemo(() => {
    const text = editContent() + editSystemPrompt();
    return Math.ceil(text.length / 4);
  });

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div class="h-full flex overflow-hidden">
      {/* ─── Left: Prompt Library ──────────────────────────────────────── */}
      <div class="w-64 shrink-0 border-r border-border flex flex-col bg-background/40">
        {/* Library header */}
        <div class="p-3 border-b border-border space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles class="w-4 h-4 text-icon-prompt" />
              Prompt Library
            </h2>
            <button
              onClick={createPrompt}
              class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="New prompt"
            >
              <Plus class="w-4 h-4" />
            </button>
          </div>
          {/* Search */}
          <div class="relative">
            <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search prompts..."
              value={filterText()}
              onInput={(e) => setFilterText(e.currentTarget.value)}
              class="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-border bg-background/60 outline-none focus:border-primary/50"
            />
          </div>
          {/* Filters */}
          <div class="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setShowFavoritesOnly((v) => !v)}
              class={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors ${
                showFavoritesOnly()
                  ? "bg-primary/20 text-primary"
                  : "bg-accent/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Star class="w-3 h-3" />
              Favorites
            </button>
            <Show when={allTags().length > 0}>
              <For each={allTags().slice(0, 5)}>
                {(tag) => (
                  <button
                    onClick={() => setFilterTag((prev) => (prev === tag ? null : tag))}
                    class={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                      filterTag() === tag
                        ? "bg-primary/20 text-primary"
                        : "bg-accent/30 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tag}
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* Prompt list */}
        <div class="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          <For each={filteredPrompts()}>
            {(prompt) => (
              <button
                onClick={() => loadPromptDetails(prompt.id)}
                class={`w-full text-left rounded-md px-2.5 py-2 transition-colors group ${
                  activePrompt()?.id === prompt.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                <div class="flex items-start justify-between gap-1">
                  <span class="text-sm font-medium truncate flex-1">{prompt.name}</span>
                  <div class="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(prompt.id);
                      }}
                      class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-accent/60 transition-opacity"
                    >
                      <Star
                        class={`w-3 h-3 ${prompt.isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
                      />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePrompt(prompt.id);
                      }}
                      class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-opacity"
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <Show when={prompt.description}>
                  <p class="text-xs text-muted-foreground/70 truncate mt-0.5">
                    {prompt.description}
                  </p>
                </Show>
                <Show when={prompt.tags.length > 0}>
                  <div class="flex gap-1 mt-1 flex-wrap">
                    <For each={prompt.tags.slice(0, 3)}>
                      {(tag) => (
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/80">
                          {tag}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </button>
            )}
          </For>

          <Show when={filteredPrompts().length === 0}>
            <div class="text-center py-8 text-xs text-muted-foreground">
              <Show when={prompts().length === 0} fallback="No matching prompts">
                <p>No prompts yet</p>
                <button
                  onClick={createPrompt}
                  class="mt-2 text-primary hover:underline"
                >
                  Create your first prompt
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* ─── Center: Prompt Editor ─────────────────────────────────────── */}
      <div class="flex-1 flex flex-col overflow-hidden">
        <Show
          when={activePrompt()}
          fallback={
            <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
              <Sparkles class="w-10 h-10 text-icon-prompt/40" />
              <p class="text-sm">Select a prompt or create a new one</p>
              <button
                onClick={createPrompt}
                class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent/40 transition-colors"
              >
                <Plus class="w-3.5 h-3.5" />
                New Prompt
              </button>
            </div>
          }
        >
          {(_prompt) => (
            <>
              {/* Toolbar */}
              <div class="shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">
                <input
                  value={editName()}
                  onInput={(e) => {
                    setEditName(e.currentTarget.value);
                    setDirty(true);
                  }}
                  class="text-sm font-semibold bg-transparent outline-none flex-1 min-w-0"
                  placeholder="Prompt name"
                />
                <span class="text-xs text-muted-foreground shrink-0">
                  ~{tokenEstimate()} tokens
                </span>
                <Show when={dirty()}>
                  <span class="text-xs text-yellow-500">unsaved</span>
                </Show>
                <button
                  onClick={copyRendered}
                  class="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                  title="Copy rendered prompt"
                >
                  <Show when={copied()} fallback={<Copy class="w-3.5 h-3.5" />}>
                    <Check class="w-3.5 h-3.5 text-green-400" />
                  </Show>
                </button>
                <button
                  onClick={analyzePrompt}
                  disabled={analyzing()}
                  class="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  title="Analyze prompt"
                >
                  <BarChart3 class="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={optimizePrompt}
                  disabled={optimizing()}
                  class="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                  title="Optimize with AI"
                >
                  <Wand2 class="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={savePrompt}
                  disabled={saving() || !dirty()}
                  class="px-3 py-1 text-xs rounded-md bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-40 transition-colors"
                >
                  {saving() ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={executePrompt}
                  disabled={executing()}
                  class="flex items-center gap-1 px-3 py-1 text-xs rounded-md bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-40 transition-colors"
                >
                  <Play class="w-3 h-3" />
                  {executing() ? "Running..." : "Run"}
                </button>
              </div>

              {/* Description + Tags */}
              <div class="shrink-0 border-b border-border px-4 py-2 space-y-2">
                <input
                  value={editDescription()}
                  onInput={(e) => {
                    setEditDescription(e.currentTarget.value);
                    setDirty(true);
                  }}
                  placeholder="Description (optional)"
                  class="w-full text-xs bg-transparent outline-none text-muted-foreground"
                />
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Tag class="w-3 h-3 text-muted-foreground shrink-0" />
                  <For each={editTags()}>
                    {(tag) => (
                      <span class="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] bg-primary/10 text-primary/80">
                        {tag}
                        <button
                          onClick={() => removeTag(tag)}
                          class="hover:text-destructive"
                        >
                          <X class="w-2.5 h-2.5" />
                        </button>
                      </span>
                    )}
                  </For>
                  <input
                    value={newTagInput()}
                    onInput={(e) => setNewTagInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="+ tag"
                    class="text-[10px] bg-transparent outline-none w-16 text-muted-foreground"
                  />
                </div>
              </div>

              {/* Editor area */}
              <div class="flex-1 flex flex-col overflow-hidden">
                {/* System prompt */}
                <div class="shrink-0 border-b border-border">
                  <div class="px-4 py-1.5 flex items-center gap-1.5">
                    <span class="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      System Prompt
                    </span>
                  </div>
                  <textarea
                    value={editSystemPrompt()}
                    onInput={(e) => {
                      setEditSystemPrompt(e.currentTarget.value);
                      setDirty(true);
                    }}
                    placeholder="You are a helpful assistant..."
                    class="w-full px-4 py-2 text-xs bg-transparent outline-none resize-none font-mono text-muted-foreground"
                    rows={2}
                  />
                </div>

                {/* User prompt */}
                <div class="flex-1 flex flex-col overflow-hidden">
                  <div class="px-4 py-1.5 flex items-center gap-1.5 shrink-0">
                    <span class="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      User Prompt
                    </span>
                    <Show when={detectedVars().length > 0}>
                      <span class="text-[10px] text-primary/60">
                        {detectedVars().length} variable{detectedVars().length > 1 ? "s" : ""}
                      </span>
                    </Show>
                  </div>
                  <textarea
                    value={editContent()}
                    onInput={(e) => {
                      setEditContent(e.currentTarget.value);
                      setDirty(true);
                    }}
                    placeholder="Write your prompt here. Use {{variable_name}} for dynamic values..."
                    class="flex-1 w-full px-4 py-2 text-sm bg-transparent outline-none resize-none font-mono leading-relaxed overflow-y-auto"
                    spellcheck={false}
                  />
                </div>
              </div>

              {/* Optimization banner */}
              <Show when={optimizeResult()}>
                {(result) => (
                  <div class="shrink-0 border-t border-border bg-primary/5 px-4 py-3 space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium flex items-center gap-1.5">
                        <Wand2 class="w-3.5 h-3.5 text-primary" />
                        AI Optimization
                        <span class="text-muted-foreground">
                          ({result().clarityScoreBefore} → {result().clarityScoreAfter})
                        </span>
                      </span>
                      <div class="flex items-center gap-1.5">
                        <button
                          onClick={applyOptimization}
                          class="px-2 py-0.5 text-xs rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => setOptimizeResult(null)}
                          class="p-0.5 rounded hover:bg-accent/60 text-muted-foreground"
                        >
                          <X class="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <ul class="space-y-0.5">
                      <For each={result().improvements}>
                        {(imp) => (
                          <li class="text-xs text-muted-foreground flex items-start gap-1.5">
                            <Check class="w-3 h-3 text-green-400 shrink-0 mt-0.5" />
                            {imp}
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>

      {/* ─── Right: Panels ─────────────────────────────────────────────── */}
      <Show when={activePrompt()}>
        <div class="w-72 shrink-0 border-l border-border flex flex-col bg-background/40 overflow-hidden">
          {/* Panel tabs */}
          <div class="shrink-0 border-b border-border flex">
            {(
              [
                ["variables", Variable, "Variables"],
                ["analysis", BarChart3, "Analysis"],
                ["executions", Play, "Runs"],
                ["history", History, "History"],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                onClick={() => setRightPanel(id as RightPanel)}
                class={`flex-1 flex items-center justify-center gap-1 py-2 text-xs transition-colors border-b-2 ${
                  rightPanel() === id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon class="w-3 h-3" />
                {label}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div class="flex-1 overflow-y-auto">
            {/* Variables panel */}
            <Show when={rightPanel() === "variables"}>
              <div class="p-3 space-y-3">
                <For each={editVariables()}>
                  {(variable, idx) => (
                    <div class="space-y-1.5 p-2.5 rounded-md bg-accent/20 border border-border/50">
                      <div class="flex items-center justify-between">
                        <code class="text-xs font-mono text-primary">{`{{${variable.name}}}`}</code>
                        <button
                          onClick={() => {
                            setEditVariables((prev) => prev.filter((_, i) => i !== idx()));
                            setDirty(true);
                          }}
                          class="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </div>
                      <input
                        value={variable.description || ""}
                        onInput={(e) => {
                          setEditVariables((prev) =>
                            prev.map((v, i) =>
                              i === idx() ? { ...v, description: e.currentTarget.value } : v,
                            ),
                          );
                          setDirty(true);
                        }}
                        placeholder="Description"
                        class="w-full text-xs px-2 py-1 rounded border border-border bg-background/60 outline-none focus:border-primary/50"
                      />
                      <div class="flex gap-1.5">
                        <select
                          value={variable.varType || "text"}
                          onChange={(e) => {
                            setEditVariables((prev) =>
                              prev.map((v, i) =>
                                i === idx() ? { ...v, varType: e.currentTarget.value } : v,
                              ),
                            );
                            setDirty(true);
                          }}
                          class="flex-1 text-xs px-2 py-1 rounded border border-border bg-background/60 outline-none"
                        >
                          <option value="text">Text</option>
                          <option value="code">Code</option>
                          <option value="number">Number</option>
                          <option value="boolean">Boolean</option>
                          <option value="select">Select</option>
                        </select>
                        <input
                          value={variable.defaultValue || ""}
                          onInput={(e) => {
                            setEditVariables((prev) =>
                              prev.map((v, i) =>
                                i === idx() ? { ...v, defaultValue: e.currentTarget.value } : v,
                              ),
                            );
                            setDirty(true);
                          }}
                          placeholder="Default"
                          class="flex-1 text-xs px-2 py-1 rounded border border-border bg-background/60 outline-none focus:border-primary/50"
                        />
                      </div>
                      {/* Test value input */}
                      <div class="pt-1 border-t border-border/30">
                        <label class="text-[10px] text-muted-foreground uppercase tracking-wider">
                          Test value
                        </label>
                        <input
                          value={variableValues()[variable.name] || ""}
                          onInput={(e) => {
                            setVariableValues((prev) => ({
                              ...prev,
                              [variable.name]: e.currentTarget.value,
                            }));
                          }}
                          placeholder={variable.defaultValue || "Enter test value..."}
                          class="w-full text-xs px-2 py-1 mt-0.5 rounded border border-border bg-background/60 outline-none focus:border-primary/50"
                        />
                      </div>
                    </div>
                  )}
                </For>

                <button
                  onClick={() => {
                    setEditVariables((prev) => [
                      ...prev,
                      { name: `var_${prev.length + 1}`, varType: "text", defaultValue: "", description: "", required: true },
                    ]);
                    setDirty(true);
                  }}
                  class="w-full flex items-center justify-center gap-1 py-1.5 text-xs rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                >
                  <Plus class="w-3 h-3" />
                  Add Variable
                </button>
              </div>
            </Show>

            {/* Analysis panel */}
            <Show when={rightPanel() === "analysis"}>
              <div class="p-3 space-y-3">
                <Show
                  when={analysis()}
                  fallback={
                    <div class="text-center py-6 text-xs text-muted-foreground">
                      <BarChart3 class="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p>Click analyze to evaluate your prompt</p>
                    </div>
                  }
                >
                  {(a) => (
                    <>
                      <div class="grid grid-cols-2 gap-2">
                        <div class="p-2 rounded-md bg-accent/20 border border-border/50 text-center">
                          <div class="text-lg font-bold text-primary">{a().clarityScore}</div>
                          <div class="text-[10px] text-muted-foreground">Clarity</div>
                        </div>
                        <div class="p-2 rounded-md bg-accent/20 border border-border/50 text-center">
                          <div class="text-lg font-bold text-primary">{a().structureScore}</div>
                          <div class="text-[10px] text-muted-foreground">Structure</div>
                        </div>
                      </div>

                      <div class="p-2 rounded-md bg-accent/20 border border-border/50 text-center">
                        <div class="text-sm font-bold">{a().tokenCount}</div>
                        <div class="text-[10px] text-muted-foreground">Estimated Tokens</div>
                      </div>

                      <Show when={a().suggestions.length > 0}>
                        <div>
                          <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                            Suggestions
                          </h4>
                          <ul class="space-y-1">
                            <For each={a().suggestions}>
                              {(s) => (
                                <li class="text-xs text-muted-foreground flex items-start gap-1.5">
                                  <Wand2 class="w-3 h-3 text-primary/60 shrink-0 mt-0.5" />
                                  {s}
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>

                      <Show when={a().riskFlags.length > 0}>
                        <div>
                          <h4 class="text-[10px] uppercase tracking-wider text-destructive/70 font-medium mb-1.5">
                            Risk Flags
                          </h4>
                          <ul class="space-y-1">
                            <For each={a().riskFlags}>
                              {(f) => (
                                <li class="text-xs text-destructive/70 flex items-start gap-1.5">
                                  <span class="shrink-0">!</span>
                                  {f}
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>

                      <Show when={a().detectedVariables.length > 0}>
                        <div>
                          <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                            Detected Variables
                          </h4>
                          <div class="flex flex-wrap gap-1">
                            <For each={a().detectedVariables}>
                              {(v) => (
                                <code class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono">
                                  {`{{${v}}}`}
                                </code>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Show>

            {/* Executions panel */}
            <Show when={rightPanel() === "executions"}>
              <div class="p-3 space-y-2">
                <Show
                  when={executions().length > 0}
                  fallback={
                    <div class="text-center py-6 text-xs text-muted-foreground">
                      <Play class="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p>No executions yet. Click Run to test.</p>
                    </div>
                  }
                >
                  <For each={executions()}>
                    {(exec) => (
                      <div class="rounded-md border border-border/50 bg-accent/10 overflow-hidden">
                        <div class="px-2.5 py-1.5 border-b border-border/30 flex items-center justify-between">
                          <span class="text-[10px] text-muted-foreground">
                            {new Date(exec.createdAt).toLocaleString()}
                          </span>
                          <div class="flex items-center gap-1.5">
                            <span class="text-[10px] text-muted-foreground">
                              {exec.durationMs}ms
                            </span>
                            <button
                              onClick={() => rateExecution(exec.id, 1)}
                              class={`p-0.5 rounded transition-colors ${
                                exec.rating === 1
                                  ? "text-green-400"
                                  : "text-muted-foreground/40 hover:text-green-400"
                              }`}
                            >
                              <ThumbsUp class="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => rateExecution(exec.id, -1)}
                              class={`p-0.5 rounded transition-colors ${
                                exec.rating === -1
                                  ? "text-destructive"
                                  : "text-muted-foreground/40 hover:text-destructive"
                              }`}
                            >
                              <ThumbsDown class="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <div class="px-2.5 py-2 text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto leading-relaxed">
                          {exec.output}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            {/* Version history panel */}
            <Show when={rightPanel() === "history"}>
              <div class="p-3 space-y-2">
                <Show
                  when={versions().length > 0}
                  fallback={
                    <div class="text-center py-6 text-xs text-muted-foreground">
                      <History class="w-6 h-6 mx-auto mb-2 opacity-40" />
                      <p>No version history yet</p>
                    </div>
                  }
                >
                  <For each={versions()}>
                    {(version) => (
                      <button
                        onClick={() => {
                          setEditContent(version.content);
                          setEditSystemPrompt(version.systemPrompt);
                          setDirty(true);
                        }}
                        class="w-full text-left rounded-md border border-border/50 bg-accent/10 px-2.5 py-2 hover:bg-accent/30 transition-colors"
                      >
                        <div class="flex items-center justify-between mb-1">
                          <span class="text-xs font-medium">v{version.version}</span>
                          <span class="text-[10px] text-muted-foreground">
                            {new Date(version.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <p class="text-xs text-muted-foreground truncate font-mono">
                          {version.content.slice(0, 80)}
                          {version.content.length > 80 ? "..." : ""}
                        </p>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
