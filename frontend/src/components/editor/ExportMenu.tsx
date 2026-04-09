import type { Editor, JSONContent } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { createSignal, Show } from "solid-js";

interface ExportMenuProps {
  editor: Editor;
}

function htmlToPlainText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

function htmlToMarkdown(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return convertNodeToMarkdown(div).trim() + "\n";
}

function convertNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const childrenMd = () => Array.from(el.childNodes).map(convertNodeToMarkdown).join("");

  switch (tag) {
    case "h1": return `# ${childrenMd().trim()}\n\n`;
    case "h2": return `## ${childrenMd().trim()}\n\n`;
    case "h3": return `### ${childrenMd().trim()}\n\n`;
    case "h4": return `#### ${childrenMd().trim()}\n\n`;
    case "h5": return `##### ${childrenMd().trim()}\n\n`;
    case "h6": return `###### ${childrenMd().trim()}\n\n`;
    case "p": return `${childrenMd().trim()}\n\n`;
    case "br": return "\n";
    case "strong":
    case "b": return `**${childrenMd()}**`;
    case "em":
    case "i": return `*${childrenMd()}*`;
    case "s":
    case "del": return `~~${childrenMd()}~~`;
    case "code": {
      // Inline code (not inside a <pre>)
      const parent = el.parentElement;
      if (parent && parent.tagName.toLowerCase() === "pre") {
        return childrenMd();
      }
      return `\`${childrenMd()}\``;
    }
    case "pre": {
      const codeEl = el.querySelector("code");
      const content = codeEl ? (codeEl.textContent ?? "") : (el.textContent ?? "");
      const lang = codeEl?.className?.match(/language-(\S+)/)?.[1] ?? "";
      return `\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
    }
    case "blockquote": {
      const inner = childrenMd().trim();
      const quoted = inner.split("\n").map((line) => `> ${line}`).join("\n");
      return `${quoted}\n\n`;
    }
    case "ul": {
      let result = "";
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() === "li") {
          const text = convertNodeToMarkdown(child).trim();
          result += `- ${text}\n`;
        }
      }
      return `${result}\n`;
    }
    case "ol": {
      let result = "";
      let idx = 1;
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() === "li") {
          const text = convertNodeToMarkdown(child).trim();
          result += `${idx}. ${text}\n`;
          idx++;
        }
      }
      return `${result}\n`;
    }
    case "li": return childrenMd();
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = childrenMd();
      return href ? `[${text}](${href})` : text;
    }
    case "hr": return `---\n\n`;
    case "img": {
      const alt = el.getAttribute("alt") ?? "";
      const src = el.getAttribute("src") ?? "";
      return `![${alt}](${src})`;
    }
    default: return childrenMd();
  }
}

interface TableRow {
  type: string;
  content: string;
  level?: number;
}

function getNodeText(node: JSONContent): string {
  return (node.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
}

function getListItemText(item: JSONContent): string {
  return (item.content ?? [])
    .flatMap((p) => (p.content ?? []).map((c) => c.text ?? ""))
    .join("");
}

function extractStructuredData(editor: Editor): TableRow[] {
  const rows: TableRow[] = [];
  const json = editor.getJSON();

  for (const node of json.content ?? []) {
    const textContent = getNodeText(node);

    switch (node.type) {
      case "heading":
        rows.push({
          type: `h${node.attrs?.level ?? 1}`,
          content: textContent,
          level: node.attrs?.level as number | undefined,
        });
        break;
      case "paragraph":
        if (textContent) rows.push({ type: "paragraph", content: textContent });
        break;
      case "bulletList":
      case "orderedList":
        for (const item of node.content ?? []) {
          rows.push({
            type: node.type === "bulletList" ? "bullet" : "numbered",
            content: getListItemText(item),
          });
        }
        break;
      case "taskList":
        for (const item of node.content ?? []) {
          const checked = (item as JSONContent).attrs?.checked ? "[x]" : "[ ]";
          rows.push({ type: "task", content: `${checked} ${getListItemText(item)}` });
        }
        break;
      case "codeBlock":
        rows.push({ type: "code", content: textContent });
        break;
      case "blockquote":
        for (const child of node.content ?? []) {
          rows.push({ type: "quote", content: getNodeText(child) });
        }
        break;
      default:
        if (textContent) rows.push({ type: node.type ?? "text", content: textContent });
    }
  }

  return rows;
}

function toCsv(rows: TableRow[]): string {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = "type,content,level";
  const lines = rows.map(
    (r) => `${escape(r.type)},${escape(r.content)},${r.level ?? ""}`,
  );
  return [header, ...lines].join("\n");
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const isTauri = "__TAURI_INTERNALS__" in window;

async function saveWithDialog(
  content: string,
  defaultPath: string,
  filterName: string,
  extension: string,
) {
  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath,
        filters: [{ name: filterName, extensions: [extension] }],
      });
      if (path) {
        await writeTextFile(path, content);
      }
      return;
    } catch {
      // fall through to blob download
    }
  }
  download(content, defaultPath, "text/plain");
}

export function ExportMenu(props: ExportMenuProps) {
  const [open, setOpen] = createSignal(false);

  const exportCsv = async () => {
    const data = extractStructuredData(props.editor);
    await saveWithDialog(toCsv(data), "export.csv", "CSV", "csv");
    setOpen(false);
  };

  const exportJson = async () => {
    const data = extractStructuredData(props.editor);
    await saveWithDialog(
      JSON.stringify(data, null, 2),
      "export.json",
      "JSON",
      "json",
    );
    setOpen(false);
  };

  const exportMarkdown = async () => {
    const html = props.editor.getHTML();
    const md = htmlToMarkdown(html);
    await saveWithDialog(md, "export.md", "Markdown", "md");
    setOpen(false);
  };

  return (
    <div class="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open())}>
        Export
      </Button>
      <Show when={open()}>
        <div class="absolute top-full right-0 mt-1 bg-popover border border-border rounded-lg shadow-md p-1 min-w-[140px] z-50">
          <TooltipWrapper label="Export as CSV — structured rows and columns">
            <button
              class="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportCsv}
            >
              CSV
            </button>
          </TooltipWrapper>
          <TooltipWrapper label="Export as JSON — full document structure with metadata">
            <button
              class="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportJson}
            >
              JSON
            </button>
          </TooltipWrapper>
          <TooltipWrapper label="Export as Markdown with formatting preserved">
            <button
              class="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              onClick={exportMarkdown}
            >
              Markdown
            </button>
          </TooltipWrapper>
        </div>
      </Show>
    </div>
  );
}
