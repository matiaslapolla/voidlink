//! Repository Intelligence runtime state.
//!
//! Owns a shared [`voidlink_core::migration::MigrationState`] (database + provider)
//! and a set of background-thread channels used to ferry scan progress, search
//! results, graph data, and dataflow analyses back to the UI thread.
//!
//! Nothing in here is persisted — the on-disk SQLite store is the source of
//! truth across runs.

use std::collections::HashSet;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use voidlink_core::migration::dataflow::DataFlowAnalysisResult;
use voidlink_core::migration::graph::RepoGraph;
use voidlink_core::migration::{
    EntityAnalysisResult, MigrationState, ScanProgress, SearchResult,
};

// ─── Scan worker messages ───────────────────────────────────────────────────

pub enum ScanMsg {
    Progress(ScanProgress),
    Done(ScanProgress),
    Error(String),
}

// ─── Search worker messages ─────────────────────────────────────────────────

pub struct SearchResponse {
    pub query: String,
    pub results: Result<Vec<SearchResult>, String>,
}

// ─── Graph worker messages ──────────────────────────────────────────────────

pub enum GraphMsg {
    Loaded(RepoGraph),
    Error(String),
}

// ─── Dataflow / entity worker messages ──────────────────────────────────────

pub enum DataFlowMsg {
    Entities(Result<EntityAnalysisResult, String>),
    Pipelines(Result<DataFlowAnalysisResult, String>),
}

// ─── Persisted filters ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoIntelFilters {
    pub languages: Vec<String>,
    pub folder: String,
    pub min_edges: u32,
}

impl Default for RepoIntelFilters {
    fn default() -> Self {
        Self {
            languages: Vec::new(),
            folder: String::new(),
            min_edges: 0,
        }
    }
}

// ─── Search mode ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Lexical,
    Semantic,
    Hybrid,
}

impl SearchMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SearchMode::Lexical => "lexical",
            SearchMode::Semantic => "semantic",
            SearchMode::Hybrid => "hybrid",
        }
    }
}

// ─── Graph view transform ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct GraphView {
    pub offset_x: f32,
    pub offset_y: f32,
    pub zoom: f32,
    pub layout_version: u32,
}

impl Default for GraphView {
    fn default() -> Self {
        Self {
            offset_x: 0.0,
            offset_y: 0.0,
            zoom: 1.0,
            layout_version: 0,
        }
    }
}

// ─── Force-directed layout cache ────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct NodePosition {
    pub x: f32,
    pub y: f32,
}

pub struct GraphLayout {
    pub positions: Vec<(String, NodePosition)>,
    pub bounds_min: (f32, f32),
    pub bounds_max: (f32, f32),
}

// ─── Repo intel state ───────────────────────────────────────────────────────

pub struct RepoIntelState {
    /// Lazily-initialized shared migration state (DB + provider).
    /// Held behind an Arc<Mutex<Option<...>>> so it can be built on first use
    /// without blocking UI startup.
    pub migration: Arc<Mutex<Option<Arc<MigrationState>>>>,

    /// Last-known repo root used to init migration state.
    pub last_repo_root: Option<String>,

    // ── Scan ────────────────────────────────────────────────────────────
    pub scan_rx: Option<Receiver<ScanMsg>>,
    pub scan_tx_keep_alive: Option<Sender<ScanMsg>>,
    pub current_scan: Option<ScanProgress>,
    pub scan_started_at: Option<Instant>,
    pub scan_summary: Option<ScanSummary>,
    pub scan_error: Option<String>,

    // ── Search ──────────────────────────────────────────────────────────
    pub search_query: String,
    pub last_dispatched_query: String,
    pub search_mode: SearchMode,
    pub search_results: Vec<SearchResult>,
    pub search_rx: Option<Receiver<SearchResponse>>,
    pub search_tx_keep_alive: Option<Sender<SearchResponse>>,
    pub search_selected: usize,
    pub search_last_edit_at: Option<Instant>,
    pub search_in_flight: bool,
    pub search_error: Option<String>,

    // ── Dep graph ───────────────────────────────────────────────────────
    pub graph: Option<RepoGraph>,
    pub graph_layout: Option<GraphLayout>,
    pub graph_rx: Option<Receiver<GraphMsg>>,
    pub graph_tx_keep_alive: Option<Sender<GraphMsg>>,
    pub graph_loading: bool,
    pub graph_error: Option<String>,
    pub graph_view: GraphView,
    pub filters: RepoIntelFilters,

    // ── Data flow / entities ───────────────────────────────────────────
    pub entities: Option<EntityAnalysisResult>,
    pub pipelines: Option<DataFlowAnalysisResult>,
    pub dataflow_rx: Option<Receiver<DataFlowMsg>>,
    pub dataflow_tx_keep_alive: Option<Sender<DataFlowMsg>>,
    pub dataflow_loading: bool,
    pub dataflow_error: Option<String>,
    pub selected_entity_category: Option<String>,
    pub selected_pipeline: Option<String>,

    /// Pending file path to open on the next UI pass (e.g. click in a result).
    pub pending_open_path: Option<String>,

    /// A list of languages discovered from the most recent scan/graph load,
    /// used to populate the filter UI.
    pub known_languages: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct ScanSummary {
    pub total_files: u64,
    pub total_chunks: u64,
    pub duration_ms: u128,
    pub languages: Vec<String>,
}

impl RepoIntelState {
    pub fn new() -> Self {
        Self {
            migration: Arc::new(Mutex::new(None)),
            last_repo_root: None,
            scan_rx: None,
            scan_tx_keep_alive: None,
            current_scan: None,
            scan_started_at: None,
            scan_summary: None,
            scan_error: None,
            search_query: String::new(),
            last_dispatched_query: String::new(),
            search_mode: SearchMode::Hybrid,
            search_results: Vec::new(),
            search_rx: None,
            search_tx_keep_alive: None,
            search_selected: 0,
            search_last_edit_at: None,
            search_in_flight: false,
            search_error: None,
            graph: None,
            graph_layout: None,
            graph_rx: None,
            graph_tx_keep_alive: None,
            graph_loading: false,
            graph_error: None,
            graph_view: GraphView::default(),
            filters: RepoIntelFilters::default(),
            entities: None,
            pipelines: None,
            dataflow_rx: None,
            dataflow_tx_keep_alive: None,
            dataflow_loading: false,
            dataflow_error: None,
            selected_entity_category: None,
            selected_pipeline: None,
            pending_open_path: None,
            known_languages: HashSet::new(),
        }
    }

    /// Returns an owned `Arc<MigrationState>`, creating it if necessary.
    /// Returns None if initialization fails (logged).
    pub fn ensure_migration(&mut self, repo_root: Option<&str>) -> Option<Arc<MigrationState>> {
        if let Some(root) = repo_root {
            self.last_repo_root = Some(root.to_string());
        }
        let mut guard = self.migration.lock().ok()?;
        if guard.is_none() {
            match MigrationState::new(self.last_repo_root.clone()) {
                Ok(m) => *guard = Some(Arc::new(m)),
                Err(e) => {
                    log::error!("Failed to initialize migration state: {}", e);
                    return None;
                }
            }
        }
        guard.clone()
    }
}

impl Default for RepoIntelState {
    fn default() -> Self {
        Self::new()
    }
}
