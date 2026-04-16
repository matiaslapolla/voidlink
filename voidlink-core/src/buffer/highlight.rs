use ropey::Rope;
use serde::Serialize;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Style, Theme, ThemeSet};
use syntect::parsing::SyntaxSet;

#[derive(Serialize, Clone)]
pub struct TokenSpan {
    pub text: String,
    pub color: String,
}

#[derive(Serialize)]
pub struct TokenizedLine {
    pub line: usize,
    pub tokens: Vec<TokenSpan>,
}

pub struct HighlightEngine {
    syntax_set: SyntaxSet,
    theme_set: ThemeSet,
}

impl HighlightEngine {
    pub fn new() -> Self {
        Self {
            syntax_set: SyntaxSet::load_defaults_newlines(),
            theme_set: ThemeSet::load_defaults(),
        }
    }

    /// Highlight lines `[start_line, end_line)` from the rope.
    ///
    /// Lines before `start_line` are parsed (for correct state) but not returned.
    /// TODO: cache ParseState at regular intervals for O(1) random-access highlighting.
    pub fn highlight_range(
        &self,
        rope: &Rope,
        file_path: &str,
        start_line: usize,
        end_line: usize,
        theme_mode: &str,
    ) -> Result<Vec<TokenizedLine>, String> {
        let syntax = self.detect_syntax(file_path);
        let theme = self.select_theme(theme_mode);
        let mut h = HighlightLines::new(syntax, theme);

        let total_lines = rope.len_lines();
        let end = end_line.min(total_lines);
        let mut result = Vec::with_capacity(end.saturating_sub(start_line));

        for i in 0..end {
            let line = rope.line(i);
            let line_str: String = line.chars().collect();

            match h.highlight_line(&line_str, &self.syntax_set) {
                Ok(regions) => {
                    if i >= start_line {
                        let mut tokens: Vec<TokenSpan> = regions
                            .iter()
                            .map(|(style, text)| TokenSpan {
                                text: text.to_string(),
                                color: style_to_hex(style),
                            })
                            .collect();
                        // Strip trailing newline from last token (ropey lines include it)
                        if let Some(last) = tokens.last_mut() {
                            let trimmed = last.text.trim_end_matches(['\n', '\r']);
                            if trimmed.len() < last.text.len() {
                                last.text = trimmed.to_string();
                            }
                            if last.text.is_empty() {
                                tokens.pop();
                            }
                        }
                        result.push(TokenizedLine { line: i, tokens });
                    }
                }
                Err(_) => {
                    if i >= start_line {
                        let plain = line_str.trim_end_matches(['\n', '\r']).to_string();
                        result.push(TokenizedLine {
                            line: i,
                            tokens: vec![TokenSpan {
                                text: plain,
                                color: "#c0c5ce".to_string(),
                            }],
                        });
                    }
                }
            }
        }

        Ok(result)
    }

    fn detect_syntax(&self, file_path: &str) -> &syntect::parsing::SyntaxReference {
        let path = std::path::Path::new(file_path);

        // Try by extension first (with mappings for common aliases)
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let mapped = match ext.to_lowercase().as_str() {
                "mjs" | "cjs" => "js",
                "mts" | "cts" => "ts",
                e => return self
                    .syntax_set
                    .find_syntax_by_extension(e)
                    .unwrap_or_else(|| self.syntax_set.find_syntax_plain_text()),
            };
            if let Some(syn) = self.syntax_set.find_syntax_by_extension(mapped) {
                return syn;
            }
        }

        // Try by filename
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let lower = name.to_lowercase();
            if lower == "makefile" || lower == "gnumakefile" {
                if let Some(syn) = self.syntax_set.find_syntax_by_name("Makefile") {
                    return syn;
                }
            }
            if lower == "dockerfile" || lower.starts_with("dockerfile.") {
                if let Some(syn) = self.syntax_set.find_syntax_by_name("Dockerfile") {
                    return syn;
                }
            }
        }

        self.syntax_set.find_syntax_plain_text()
    }

    fn select_theme(&self, theme_mode: &str) -> &Theme {
        let theme_name = if theme_mode == "light" {
            "InspiredGitHub"
        } else {
            "base16-ocean.dark"
        };
        self.theme_set
            .themes
            .get(theme_name)
            .unwrap_or_else(|| self.theme_set.themes.values().next().unwrap())
    }
}

fn style_to_hex(style: &Style) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        style.foreground.r, style.foreground.g, style.foreground.b
    )
}
