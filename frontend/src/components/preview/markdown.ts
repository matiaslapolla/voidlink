import { marked } from "marked";
import DOMPurify from "dompurify";

/// Shared markdown → sanitized HTML rendering, used by MarkdownPreview (file
/// tab) and BrainSurface (entry detail pane) so both stay in sync.
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source, { async: false, breaks: false, gfm: true }) as string;
  return DOMPurify.sanitize(raw);
}
