//! Rail-card deck state (polish plan §4.3).
//!
//! `RailCardState` describes one card in the right rail: its kind, collapsed
//! state, and per-kind meta (Preview URL, Terminal PTY id, Logs source).
//! Order in the `Vec<RailCardState>` is the stacking order top-to-bottom.
//!
//! ED-C persists the deck runtime-only (not on disk) until ED-E wires sessions.
//! The in-memory store here is the source of truth.

use serde::{Deserialize, Serialize};

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum RailCardKind {
    Preview,
    Changes,
    Terminal,
    Tasks,
    Plan,
    PrReview,
    Logs,
}

impl RailCardKind {
    pub const ALL: &[RailCardKind] = &[
        RailCardKind::Preview,
        RailCardKind::Changes,
        RailCardKind::Terminal,
        RailCardKind::Tasks,
        RailCardKind::Plan,
        RailCardKind::PrReview,
        RailCardKind::Logs,
    ];

    pub fn title(&self) -> &'static str {
        match self {
            RailCardKind::Preview => "Preview",
            RailCardKind::Changes => "Changes",
            RailCardKind::Terminal => "Terminal",
            RailCardKind::Tasks => "Tasks",
            RailCardKind::Plan => "Plan",
            RailCardKind::PrReview => "PR Review",
            RailCardKind::Logs => "Logs",
        }
    }

    pub fn icon(&self) -> &'static str {
        match self {
            RailCardKind::Preview => "\u{1F50D}",   // magnifier
            RailCardKind::Changes => "\u{270E}",    // pencil
            RailCardKind::Terminal => "\u{2B9A}",   // terminal-ish arrow; fallback below
            RailCardKind::Tasks => "\u{2611}",      // ballot box with check
            RailCardKind::Plan => "\u{1F4CB}",      // clipboard
            RailCardKind::PrReview => "\u{26A1}",   // bolt
            RailCardKind::Logs => "\u{2263}",       // triple-bar
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LogSource {
    All,
    Stdout,
    Stderr,
    Lsp,
    Pipeline,
}

impl Default for LogSource {
    fn default() -> Self {
        LogSource::All
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RailCardMeta {
    None,
    Preview { url: String },
    Terminal { pty_id: u64 },
    Logs { source: LogSource },
}

impl Default for RailCardMeta {
    fn default() -> Self {
        RailCardMeta::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RailCardState {
    pub kind: RailCardKind,
    pub collapsed: bool,
    pub meta: RailCardMeta,
}

impl RailCardState {
    pub fn new(kind: RailCardKind) -> Self {
        let meta = match kind {
            RailCardKind::Preview => RailCardMeta::Preview {
                url: "http://localhost:5173".to_string(),
            },
            RailCardKind::Terminal => RailCardMeta::Terminal { pty_id: 0 },
            RailCardKind::Logs => RailCardMeta::Logs {
                source: LogSource::All,
            },
            _ => RailCardMeta::None,
        };
        Self {
            kind,
            collapsed: false,
            meta,
        }
    }
}

pub struct RailDeck {
    pub cards: Vec<RailCardState>,
}

impl Default for RailDeck {
    fn default() -> Self {
        Self::default_deck()
    }
}

impl RailDeck {
    /// The seed deck for a fresh session: Changes + Terminal + Plan stacked.
    pub fn default_deck() -> Self {
        Self {
            cards: vec![
                RailCardState::new(RailCardKind::Changes),
                RailCardState::new(RailCardKind::Terminal),
                RailCardState::new(RailCardKind::Plan),
            ],
        }
    }

    pub fn contains(&self, kind: RailCardKind) -> bool {
        self.cards.iter().any(|c| c.kind == kind)
    }

    /// Add a card of `kind` if not already present; appended to bottom.
    pub fn add(&mut self, kind: RailCardKind) {
        if !self.contains(kind) {
            self.cards.push(RailCardState::new(kind));
        }
    }

    pub fn dismiss(&mut self, kind: RailCardKind) {
        self.cards.retain(|c| c.kind != kind);
    }

    pub fn move_up(&mut self, kind: RailCardKind) {
        if let Some(idx) = self.cards.iter().position(|c| c.kind == kind) {
            if idx > 0 {
                self.cards.swap(idx - 1, idx);
            }
        }
    }

    pub fn move_down(&mut self, kind: RailCardKind) {
        if let Some(idx) = self.cards.iter().position(|c| c.kind == kind) {
            if idx + 1 < self.cards.len() {
                self.cards.swap(idx, idx + 1);
            }
        }
    }

    /// Kinds not currently in the deck — drives the `+` popover menu.
    pub fn available_to_add(&self) -> Vec<RailCardKind> {
        RailCardKind::ALL
            .iter()
            .copied()
            .filter(|k| !self.contains(*k))
            .collect()
    }
}
