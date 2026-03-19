import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { marked } from "marked";

const MD_PATTERN = /^(#{1,6} |[*_]{1,2}|\d+\. |- |\* |> |`|!\[|\[)/m;

export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const data = event.clipboardData;
            if (!data) return false;

            const html = data.getData("text/html");
            if (html) return false;

            const text = data.getData("text/plain");
            if (!text || !MD_PATTERN.test(text)) return false;

            const parsed = marked.parse(text, { async: false }) as string;
            editor.commands.insertContent(parsed, {
              parseOptions: { preserveWhitespace: false },
            });
            return true;
          },
        },
      }),
    ];
  },
});
