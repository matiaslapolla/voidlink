/// The Monaco themes, derived from VoidLink's own CSS custom properties.
///
/// VoidLink ships eight named themes plus a light/dark pair, and MASTER.md
/// §11.5 names "Monaco-drift" as this module's identity risk: stock `vs` /
/// `vs-dark` sit inside a `solarized-light` shell and read as somebody else's
/// editor pasted into the app. Hardcoding ten Monaco themes would fix the look
/// and break the moment a token moves, so instead there are exactly two theme
/// *definitions* — `voidlink-dark` and `voidlink-light` — whose colours are
/// read from `getComputedStyle(document.documentElement)` at definition time.
/// Switching theme re-reads the tokens and redefines them, so all ten themes
/// (and any future one) work with no code change here.
///
/// Everything in this file below `readCssTokens` is pure: it maps a token
/// record to a Monaco theme object. That is what makes it testable in `node`,
/// where there is no cascade to compute.

import type * as Monaco from "monaco-editor";
import { cssColorToHex } from "./cssColor";
import type { ThemeMode } from "@/store/theme";

export const VOIDLINK_DARK = "voidlink-dark";
export const VOIDLINK_LIGHT = "voidlink-light";

/// The Monaco theme name for an app mode. The only place the two vocabularies
/// meet — nothing else should be building these strings.
export function monacoThemeName(mode: ThemeMode): string {
  return mode === "light" ? VOIDLINK_LIGHT : VOIDLINK_DARK;
}

/// The design tokens the editor surface consumes. Named rather than open so a
/// missing token is a type error instead of a black editor.
export const THEME_TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--success",
  "--warning",
  "--info",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--sidebar",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

/// Snapshot the live cascade. Reads `<html>`, which is where both the mode
/// class and `data-theme` land (see `store/theme.ts`), so a named theme's
/// overrides are already resolved by the time this runs.
export function readCssTokens(el: Element = document.documentElement): ThemeTokens {
  const computed = getComputedStyle(el);
  const out = {} as ThemeTokens;
  for (const name of THEME_TOKEN_NAMES) {
    out[name] = computed.getPropertyValue(name).trim();
  }
  return out;
}

/// Monaco token rules take a bare 6-digit hex with no `#` and no alpha, which
/// is a different format from the `colors` map. Two helpers rather than one
/// flag, because mixing them up produces a theme that silently ignores half its
/// rules.
function rule(tokens: ThemeTokens, name: ThemeTokenName): string | undefined {
  const hex = cssColorToHex(tokens[name], { over: tokens["--background"] });
  return hex ? hex.slice(1, 7) : undefined;
}

function color(
  tokens: ThemeTokens,
  name: ThemeTokenName,
  opts: { alpha?: number; opaque?: boolean } = {},
): string | undefined {
  const hex = cssColorToHex(tokens[name], {
    alpha: opts.alpha,
    over: opts.opaque ? tokens["--background"] : undefined,
  });
  return hex ?? undefined;
}

/// Drop the keys whose token failed to parse. Monaco falls back to its base
/// theme for anything absent, which is a better failure than `#000000`.
function defined(entries: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) if (v) out[k] = v;
  return out;
}

/// Token-colour rules. Deliberately short: VoidLink's palette carries five
/// chart hues plus primary, and mapping every TextMate scope to a bespoke
/// colour is how a theme stops surviving a token change. `inherit: true` keeps
/// Monaco's own rules underneath for anything not listed.
function tokenRules(tokens: ThemeTokens): Monaco.editor.ITokenThemeRule[] {
  const comment = rule(tokens, "--muted-foreground");
  const keyword = rule(tokens, "--primary");
  const string = rule(tokens, "--chart-2");
  const number = rule(tokens, "--chart-3");
  const type = rule(tokens, "--chart-4");
  const variable = rule(tokens, "--foreground");
  const invalid = rule(tokens, "--destructive");
  const meta = rule(tokens, "--chart-1");

  const rules: (Monaco.editor.ITokenThemeRule | null)[] = [
    comment ? { token: "comment", foreground: comment, fontStyle: "italic" } : null,
    keyword ? { token: "keyword", foreground: keyword } : null,
    keyword ? { token: "operator", foreground: keyword } : null,
    keyword ? { token: "keyword.control", foreground: keyword } : null,
    string ? { token: "string", foreground: string } : null,
    string ? { token: "regexp", foreground: string } : null,
    number ? { token: "number", foreground: number } : null,
    number ? { token: "constant", foreground: number } : null,
    type ? { token: "type", foreground: type } : null,
    type ? { token: "type.identifier", foreground: type } : null,
    meta ? { token: "tag", foreground: meta } : null,
    meta ? { token: "attribute.name", foreground: meta } : null,
    meta ? { token: "annotation", foreground: meta } : null,
    variable ? { token: "identifier", foreground: variable } : null,
    variable ? { token: "delimiter", foreground: variable } : null,
    invalid ? { token: "invalid", foreground: invalid } : null,
  ];
  return rules.filter((r): r is Monaco.editor.ITokenThemeRule => r !== null);
}

/// Colour ids. Grouped by surface so a missing group is obvious at a glance.
/// The alpha values are the same ratios the app uses in Tailwind (`/15`, `/40`)
/// so a Monaco widget and a VoidLink popover next to each other match.
function editorColors(tokens: ThemeTokens): Record<string, string> {
  return defined({
    // ── Canvas
    "editor.background": color(tokens, "--background", { opaque: true }),
    "editor.foreground": color(tokens, "--foreground", { opaque: true }),
    "editorCursor.foreground": color(tokens, "--primary", { opaque: true }),
    "editor.lineHighlightBackground": color(tokens, "--accent", { alpha: 0.45 }),
    "editor.selectionBackground": color(tokens, "--primary", { alpha: 0.3 }),
    "editor.inactiveSelectionBackground": color(tokens, "--primary", { alpha: 0.15 }),
    "editor.selectionHighlightBackground": color(tokens, "--primary", { alpha: 0.15 }),
    "editor.wordHighlightBackground": color(tokens, "--primary", { alpha: 0.12 }),
    "editor.wordHighlightStrongBackground": color(tokens, "--primary", { alpha: 0.2 }),
    "editor.findMatchBackground": color(tokens, "--primary", { alpha: 0.35 }),
    "editor.findMatchHighlightBackground": color(tokens, "--primary", { alpha: 0.18 }),
    "editorWhitespace.foreground": color(tokens, "--muted-foreground", { alpha: 0.35 }),
    "editorGhostText.foreground": color(tokens, "--muted-foreground", { alpha: 0.6 }),
    "editorLink.activeForeground": color(tokens, "--primary", { opaque: true }),

    // ── Gutter
    "editorGutter.background": color(tokens, "--background", { opaque: true }),
    "editorLineNumber.foreground": color(tokens, "--muted-foreground", { alpha: 0.55 }),
    "editorLineNumber.activeForeground": color(tokens, "--foreground", { opaque: true }),
    "editorIndentGuide.background1": color(tokens, "--border", { alpha: 0.7 }),
    "editorIndentGuide.activeBackground1": color(tokens, "--primary", { alpha: 0.4 }),
    "editorRuler.foreground": color(tokens, "--border"),
    "editorOverviewRuler.border": "#00000000",

    // ── Sticky scroll (Monaco 0.55 renders it as its own surface)
    "editorStickyScroll.background": color(tokens, "--sidebar", { opaque: true }),
    "editorStickyScrollHover.background": color(tokens, "--accent", { opaque: true }),

    // ── Brackets. Six ids, five chart hues plus primary.
    "editorBracketMatch.background": color(tokens, "--primary", { alpha: 0.2 }),
    "editorBracketMatch.border": color(tokens, "--primary", { alpha: 0.5 }),
    "editorBracketHighlight.foreground1": color(tokens, "--chart-1", { opaque: true }),
    "editorBracketHighlight.foreground2": color(tokens, "--chart-2", { opaque: true }),
    "editorBracketHighlight.foreground3": color(tokens, "--chart-3", { opaque: true }),
    "editorBracketHighlight.foreground4": color(tokens, "--chart-4", { opaque: true }),
    "editorBracketHighlight.foreground5": color(tokens, "--chart-5", { opaque: true }),
    "editorBracketHighlight.foreground6": color(tokens, "--primary", { opaque: true }),
    "editorBracketHighlight.unexpectedBracket.foreground": color(tokens, "--destructive", {
      opaque: true,
    }),

    // ── Markers
    "editorError.foreground": color(tokens, "--destructive", { opaque: true }),
    "editorWarning.foreground": color(tokens, "--warning", { opaque: true }),
    "editorInfo.foreground": color(tokens, "--info", { opaque: true }),

    // ── Widgets: suggest, hover, find, parameter hints. These are the surfaces
    // that read as "VS Code" if left stock, so they take the popover token.
    "editorWidget.background": color(tokens, "--popover", { opaque: true }),
    "editorWidget.foreground": color(tokens, "--popover-foreground", { opaque: true }),
    "editorWidget.border": color(tokens, "--border"),
    "editorSuggestWidget.background": color(tokens, "--popover", { opaque: true }),
    "editorSuggestWidget.foreground": color(tokens, "--popover-foreground", { opaque: true }),
    "editorSuggestWidget.border": color(tokens, "--border"),
    "editorSuggestWidget.selectedBackground": color(tokens, "--primary", { alpha: 0.15 }),
    "editorSuggestWidget.highlightForeground": color(tokens, "--primary", { opaque: true }),
    "editorHoverWidget.background": color(tokens, "--popover", { opaque: true }),
    "editorHoverWidget.foreground": color(tokens, "--popover-foreground", { opaque: true }),
    "editorHoverWidget.border": color(tokens, "--border"),
    "peekViewEditor.background": color(tokens, "--background", { opaque: true }),
    "peekViewResult.background": color(tokens, "--sidebar", { opaque: true }),
    "peekViewTitle.background": color(tokens, "--sidebar", { opaque: true }),

    // ── Shared chrome the widgets borrow
    "input.background": color(tokens, "--muted", { opaque: true }),
    "input.foreground": color(tokens, "--foreground", { opaque: true }),
    "input.border": color(tokens, "--input"),
    "focusBorder": color(tokens, "--ring", { alpha: 0.7 }),
    "list.hoverBackground": color(tokens, "--accent", { alpha: 0.6 }),
    "list.focusBackground": color(tokens, "--primary", { alpha: 0.15 }),
    "list.activeSelectionBackground": color(tokens, "--primary", { alpha: 0.15 }),
    "list.activeSelectionForeground": color(tokens, "--foreground", { opaque: true }),
    "list.highlightForeground": color(tokens, "--primary", { opaque: true }),
    "scrollbarSlider.background": color(tokens, "--muted-foreground", { alpha: 0.2 }),
    "scrollbarSlider.hoverBackground": color(tokens, "--muted-foreground", { alpha: 0.3 }),
    "scrollbarSlider.activeBackground": color(tokens, "--muted-foreground", { alpha: 0.45 }),
    "menu.background": color(tokens, "--popover", { opaque: true }),
    "menu.foreground": color(tokens, "--popover-foreground", { opaque: true }),
    "menu.selectionBackground": color(tokens, "--primary", { alpha: 0.15 }),

    // ── Diff and merge. `DiffTabView` and `MergeEditor` are Monaco diff editors
    // sitting inside VoidLink's own diff chrome, so these must agree with the
    // `--success` / `--destructive` the surrounding rows use.
    "diffEditor.insertedTextBackground": color(tokens, "--success", { alpha: 0.16 }),
    "diffEditor.removedTextBackground": color(tokens, "--destructive", { alpha: 0.16 }),
    "diffEditor.insertedLineBackground": color(tokens, "--success", { alpha: 0.08 }),
    "diffEditor.removedLineBackground": color(tokens, "--destructive", { alpha: 0.08 }),
    "diffEditor.border": color(tokens, "--border"),
    "diffEditorGutter.insertedLineBackground": color(tokens, "--success", { alpha: 0.1 }),
    "diffEditorGutter.removedLineBackground": color(tokens, "--destructive", { alpha: 0.1 }),
    "merge.currentHeaderBackground": color(tokens, "--success", { alpha: 0.25 }),
    "merge.currentContentBackground": color(tokens, "--success", { alpha: 0.1 }),
    "merge.incomingHeaderBackground": color(tokens, "--info", { alpha: 0.25 }),
    "merge.incomingContentBackground": color(tokens, "--info", { alpha: 0.1 }),
  });
}

/// The full theme object for one mode. Pure — `tokens` is the only input.
export function deriveMonacoTheme(
  mode: ThemeMode,
  tokens: ThemeTokens,
): Monaco.editor.IStandaloneThemeData {
  return {
    // `inherit: true` against the matching stock base, so any colour id we do
    // not name still lands somewhere sensible rather than at Monaco's default
    // for the *other* mode.
    base: mode === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: tokenRules(tokens),
    colors: editorColors(tokens),
  };
}

/// (Re)define both themes from the live cascade and apply the one matching
/// `mode`. Monaco's theme registry is global, so this is safe to call from any
/// surface — every editor in the window picks the new colours up immediately.
///
/// Called on mount and on every theme change: `defineTheme` on an existing name
/// replaces the definition, which is how ten VoidLink themes fit into two
/// Monaco ones.
///
/// Both names are defined from the *same* snapshot, because the cascade only
/// ever holds one theme: `--background` under `solarized-light` is the light
/// value, full stop. The app's mode and the active theme's mode cannot
/// disagree (`store/theme.ts` sets both together), so the one that gets applied
/// is always the one whose tokens were just read; the other exists so a surface
/// created mid-switch never names an undefined theme.
export function applyVoidlinkTheme(monaco: typeof Monaco, mode: ThemeMode): string {
  const tokens = readCssTokens();
  monaco.editor.defineTheme(VOIDLINK_DARK, deriveMonacoTheme("dark", tokens));
  monaco.editor.defineTheme(VOIDLINK_LIGHT, deriveMonacoTheme("light", tokens));
  const name = monacoThemeName(mode);
  monaco.editor.setTheme(name);
  return name;
}
