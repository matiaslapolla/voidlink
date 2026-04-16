//! Repository Intelligence UI: sidebar page + search/depgraph/dataflow tabs.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use eframe::egui;
use eframe::epaint::CornerRadius;

use voidlink_core::migration::graph::{GraphNode, RepoGraph};
use voidlink_core::migration::{
    self, MigrationState, ScanOptions, SearchOptions, SearchQuery, SearchResult,
};

use crate::state::repo_intel::{
    DataFlowMsg, GraphLayout, GraphMsg, NodePosition, ScanMsg, ScanSummary, SearchMode,
    SearchResponse,
};
use crate::state::{AppState, RuntimeState};
use crate::theme::ThemePalette;

// ─── Sidebar page ───────────────────────────────────────────────────────────

pub fn repo_intel_sidebar(ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    let repo_root = state
        .active_workspace()
        .and_then(|w| w.repo_root.clone());

    let Some(repo_root) = repo_root else {
        ui.add_space(8.0);
        ui.label(
            egui::RichText::new("No repository open")
                .color(p.text_muted)
                .size(12.0),
        );
        return;
    };

    // Drain any in-flight worker messages for scan / graph / dataflow.
    drain_scan_msgs(runtime, ui.ctx());
    drain_graph_msgs(runtime, ui.ctx());
    drain_dataflow_msgs(runtime, ui.ctx());

    egui::ScrollArea::vertical().show(ui, |ui| {
        ui.add_space(4.0);

        // ── Scan actions ────────────────────────────────────────────────
        let scan_running = runtime
            .repo_intel
            .current_scan
            .as_ref()
            .map(|s| s.status == "running" || s.status == "pending")
            .unwrap_or(false);

        ui.horizontal(|ui| {
            let scan_label = if scan_running { "Scanning..." } else { "Scan repository" };
            let scan_btn = ui.add_enabled(
                !scan_running,
                egui::Button::new(
                    egui::RichText::new(scan_label)
                        .size(11.0)
                        .color(p.primary),
                )
                .fill(p.primary.linear_multiply(0.1))
                .corner_radius(CornerRadius::same(4)),
            );
            if scan_btn.clicked() {
                trigger_scan(runtime, &repo_root, false, ui.ctx());
            }
        });

        ui.add_space(4.0);
        ui.horizontal(|ui| {
            if ui
                .add_enabled(
                    !scan_running,
                    egui::Button::new(
                        egui::RichText::new("Re-scan")
                            .size(10.0)
                            .color(p.text_secondary),
                    )
                    .frame(false),
                )
                .clicked()
            {
                trigger_scan(runtime, &repo_root, true, ui.ctx());
            }
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("Clear cache")
                            .size(10.0)
                            .color(p.text_secondary),
                    )
                    .frame(false),
                )
                .clicked()
            {
                runtime.repo_intel.graph = None;
                runtime.repo_intel.graph_layout = None;
                runtime.repo_intel.entities = None;
                runtime.repo_intel.pipelines = None;
                runtime.repo_intel.search_results.clear();
                runtime.repo_intel.scan_summary = None;
            }
        });

        ui.add_space(6.0);

        // ── Progress indicator ──────────────────────────────────────────
        if let Some(ref progress) = runtime.repo_intel.current_scan {
            ui.separator();
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new(format!("Status: {}", progress.status))
                    .size(11.0)
                    .color(p.text),
            );
            ui.label(
                egui::RichText::new(format!("Files scanned: {}", progress.scanned_files))
                    .size(11.0)
                    .color(p.text_secondary),
            );
            ui.label(
                egui::RichText::new(format!("Files indexed: {}", progress.indexed_files))
                    .size(11.0)
                    .color(p.text_secondary),
            );
            ui.label(
                egui::RichText::new(format!("Chunks: {}", progress.indexed_chunks))
                    .size(11.0)
                    .color(p.text_secondary),
            );
            if let Some(ref err) = progress.error {
                ui.label(
                    egui::RichText::new(err)
                        .size(10.0)
                        .color(p.error),
                );
            }
        }

        if let Some(ref err) = runtime.repo_intel.scan_error {
            ui.label(egui::RichText::new(err).size(10.0).color(p.error));
        }

        // ── Scan summary ────────────────────────────────────────────────
        if let Some(ref summary) = runtime.repo_intel.scan_summary {
            ui.separator();
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Last scan")
                    .size(11.0)
                    .color(p.text)
                    .strong(),
            );
            ui.label(
                egui::RichText::new(format!("{} files", summary.total_files))
                    .size(10.0)
                    .color(p.text_secondary),
            );
            ui.label(
                egui::RichText::new(format!("{} chunks", summary.total_chunks))
                    .size(10.0)
                    .color(p.text_secondary),
            );
            ui.label(
                egui::RichText::new(format!(
                    "Duration: {:.1}s",
                    (summary.duration_ms as f32) / 1000.0
                ))
                .size(10.0)
                .color(p.text_secondary),
            );
            if !summary.languages.is_empty() {
                ui.label(
                    egui::RichText::new(format!(
                        "Languages: {}",
                        summary.languages.join(", ")
                    ))
                    .size(10.0)
                    .color(p.text_muted),
                );
            }
        }

        ui.add_space(8.0);
        ui.separator();
        ui.add_space(4.0);

        // ── Navigation links to tabs ────────────────────────────────────
        ui.label(
            egui::RichText::new("Views")
                .size(11.0)
                .color(p.text)
                .strong(),
        );
        ui.add_space(2.0);
        if sidebar_link(ui, "\u{1F50D}  Search", p).clicked() {
            runtime.open_search_tab();
        }
        if sidebar_link(ui, "\u{1F5FA}  Dependency Graph", p).clicked() {
            runtime.open_dep_graph_tab();
            load_graph_if_needed(runtime, &repo_root, ui.ctx());
        }
        if sidebar_link(ui, "\u{27A1}  Data Flow", p).clicked() {
            runtime.open_data_flow_tab();
            load_dataflow_if_needed(runtime, &repo_root, ui.ctx());
        }
    });
}

fn sidebar_link(ui: &mut egui::Ui, label: &str, p: ThemePalette) -> egui::Response {
    ui.add(
        egui::Button::new(
            egui::RichText::new(label)
                .size(11.0)
                .color(p.text_secondary),
        )
        .frame(false),
    )
}

// ─── Scan orchestration ─────────────────────────────────────────────────────

fn trigger_scan(
    runtime: &mut RuntimeState,
    repo_root: &str,
    force_full: bool,
    ctx: &egui::Context,
) {
    let Some(migration) = runtime.repo_intel.ensure_migration(Some(repo_root)) else {
        runtime.repo_intel.scan_error =
            Some("Failed to initialize migration database".to_string());
        return;
    };

    let options = Some(ScanOptions {
        force_full_rescan: force_full,
        max_file_size_bytes: None,
    });
    let job_id = match migration::scan_repository(&migration, repo_root.to_string(), options) {
        Ok(id) => id,
        Err(e) => {
            runtime.repo_intel.scan_error = Some(e);
            return;
        }
    };

    let (tx, rx) = mpsc::channel::<ScanMsg>();
    runtime.repo_intel.scan_rx = Some(rx);
    runtime.repo_intel.scan_tx_keep_alive = Some(tx.clone());
    runtime.repo_intel.scan_started_at = Some(Instant::now());
    runtime.repo_intel.scan_error = None;
    runtime.repo_intel.current_scan = None;

    // Poller thread: repeatedly asks migration for job status until terminal.
    let migration_clone = migration.clone();
    let ctx_clone = ctx.clone();
    std::thread::spawn(move || {
        loop {
            match migration::get_scan_status(&migration_clone, &job_id) {
                Ok(progress) => {
                    let terminal = progress.status == "completed"
                        || progress.status == "failed";
                    let snapshot = progress.clone();
                    let msg = if terminal {
                        ScanMsg::Done(snapshot)
                    } else {
                        ScanMsg::Progress(snapshot)
                    };
                    if tx.send(msg).is_err() {
                        break;
                    }
                    ctx_clone.request_repaint();
                    if terminal {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(ScanMsg::Error(e));
                    ctx_clone.request_repaint();
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn drain_scan_msgs(runtime: &mut RuntimeState, ctx: &egui::Context) {
    let Some(rx) = runtime.repo_intel.scan_rx.as_ref() else {
        return;
    };
    let mut done_progress: Option<voidlink_core::migration::ScanProgress> = None;
    let mut error: Option<String> = None;
    loop {
        match rx.try_recv() {
            Ok(ScanMsg::Progress(p)) => {
                runtime.repo_intel.current_scan = Some(p);
            }
            Ok(ScanMsg::Done(p)) => {
                done_progress = Some(p.clone());
                runtime.repo_intel.current_scan = Some(p);
            }
            Ok(ScanMsg::Error(e)) => {
                error = Some(e);
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                runtime.repo_intel.scan_rx = None;
                runtime.repo_intel.scan_tx_keep_alive = None;
                break;
            }
        }
    }
    if let Some(e) = error {
        runtime.repo_intel.scan_error = Some(e);
    }
    if let Some(p) = done_progress {
        // Tear down channel
        runtime.repo_intel.scan_rx = None;
        runtime.repo_intel.scan_tx_keep_alive = None;

        // Build summary
        let duration_ms = runtime
            .repo_intel
            .scan_started_at
            .map(|t| t.elapsed().as_millis())
            .unwrap_or(0);
        let languages = compute_language_list(runtime);
        runtime.repo_intel.scan_summary = Some(ScanSummary {
            total_files: p.indexed_files,
            total_chunks: p.indexed_chunks,
            duration_ms,
            languages,
        });

        // Invalidate derived caches.
        runtime.repo_intel.graph = None;
        runtime.repo_intel.graph_layout = None;
        runtime.repo_intel.entities = None;
        runtime.repo_intel.pipelines = None;

        ctx.request_repaint();
    }
}

fn compute_language_list(runtime: &RuntimeState) -> Vec<String> {
    let mut langs: Vec<String> = runtime
        .repo_intel
        .known_languages
        .iter()
        .cloned()
        .collect();
    langs.sort();
    langs
}

// ─── Graph loading ──────────────────────────────────────────────────────────

pub fn load_graph_if_needed(
    runtime: &mut RuntimeState,
    repo_root: &str,
    ctx: &egui::Context,
) {
    if runtime.repo_intel.graph.is_some() || runtime.repo_intel.graph_loading {
        return;
    }
    let Some(migration) = runtime.repo_intel.ensure_migration(Some(repo_root)) else {
        runtime.repo_intel.graph_error = Some("Migration state unavailable".to_string());
        return;
    };
    let (tx, rx) = mpsc::channel::<GraphMsg>();
    runtime.repo_intel.graph_rx = Some(rx);
    runtime.repo_intel.graph_tx_keep_alive = Some(tx.clone());
    runtime.repo_intel.graph_loading = true;
    runtime.repo_intel.graph_error = None;

    let repo = repo_root.to_string();
    let ctx_clone = ctx.clone();
    std::thread::spawn(move || {
        let msg = match migration::get_repo_graph(&migration, &repo) {
            Ok(g) => GraphMsg::Loaded(g),
            Err(e) => GraphMsg::Error(e),
        };
        let _ = tx.send(msg);
        ctx_clone.request_repaint();
    });
}

fn drain_graph_msgs(runtime: &mut RuntimeState, _ctx: &egui::Context) {
    let Some(rx) = runtime.repo_intel.graph_rx.as_ref() else {
        return;
    };
    loop {
        match rx.try_recv() {
            Ok(GraphMsg::Loaded(g)) => {
                for node in &g.nodes {
                    if let Some(lang) = &node.language {
                        runtime.repo_intel.known_languages.insert(lang.clone());
                    }
                }
                runtime.repo_intel.graph_layout = Some(layout_graph(&g));
                runtime.repo_intel.graph = Some(g);
                runtime.repo_intel.graph_loading = false;
            }
            Ok(GraphMsg::Error(e)) => {
                runtime.repo_intel.graph_error = Some(e);
                runtime.repo_intel.graph_loading = false;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                runtime.repo_intel.graph_rx = None;
                runtime.repo_intel.graph_tx_keep_alive = None;
                break;
            }
        }
    }
    if !runtime.repo_intel.graph_loading {
        runtime.repo_intel.graph_rx = None;
        runtime.repo_intel.graph_tx_keep_alive = None;
    }
}

/// Deterministic, simple circle-packed layout. Not a true force-directed
/// simulation — enough for 5k-file repos without a runtime sim loop.
fn layout_graph(graph: &RepoGraph) -> GraphLayout {
    let n = graph.nodes.len().max(1);
    let mut positions = Vec::with_capacity(n);

    // Concentric-ring layout by node degree (high-degree nodes in the center).
    let mut degrees: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for edge in &graph.edges {
        *degrees.entry(edge.source.as_str()).or_insert(0) += 1;
        *degrees.entry(edge.target.as_str()).or_insert(0) += 1;
    }

    let mut ordered: Vec<(&GraphNode, u32)> = graph
        .nodes
        .iter()
        .map(|n| (n, *degrees.get(n.id.as_str()).unwrap_or(&0)))
        .collect();
    ordered.sort_by(|a, b| b.1.cmp(&a.1));

    let radius_step = 60.0_f32;
    let mut ring = 0usize;
    let mut placed_in_ring = 0usize;
    let mut ring_capacity = 1usize;

    for (i, (node, _)) in ordered.iter().enumerate() {
        if placed_in_ring >= ring_capacity {
            ring += 1;
            placed_in_ring = 0;
            ring_capacity = (ring * 6).max(1);
        }
        let r = ring as f32 * radius_step;
        let theta = (placed_in_ring as f32) / (ring_capacity as f32) * std::f32::consts::TAU;
        let x = if ring == 0 { 0.0 } else { r * theta.cos() };
        let y = if ring == 0 { 0.0 } else { r * theta.sin() };
        positions.push((node.id.clone(), NodePosition { x, y }));
        placed_in_ring += 1;
        let _ = i;
    }

    let (mut min_x, mut min_y) = (0.0_f32, 0.0_f32);
    let (mut max_x, mut max_y) = (0.0_f32, 0.0_f32);
    for (_, pos) in &positions {
        min_x = min_x.min(pos.x);
        min_y = min_y.min(pos.y);
        max_x = max_x.max(pos.x);
        max_y = max_y.max(pos.y);
    }

    GraphLayout {
        positions,
        bounds_min: (min_x, min_y),
        bounds_max: (max_x, max_y),
    }
}

// ─── Dataflow / entity loading ──────────────────────────────────────────────

pub fn load_dataflow_if_needed(
    runtime: &mut RuntimeState,
    repo_root: &str,
    ctx: &egui::Context,
) {
    if runtime.repo_intel.dataflow_loading
        || (runtime.repo_intel.entities.is_some() && runtime.repo_intel.pipelines.is_some())
    {
        return;
    }
    let Some(migration) = runtime.repo_intel.ensure_migration(Some(repo_root)) else {
        runtime.repo_intel.dataflow_error = Some("Migration state unavailable".to_string());
        return;
    };
    let (tx, rx) = mpsc::channel::<DataFlowMsg>();
    runtime.repo_intel.dataflow_rx = Some(rx);
    runtime.repo_intel.dataflow_tx_keep_alive = Some(tx.clone());
    runtime.repo_intel.dataflow_loading = true;
    runtime.repo_intel.dataflow_error = None;

    let repo = repo_root.to_string();
    let ctx_clone = ctx.clone();
    let migration_clone = migration.clone();
    let tx_clone = tx.clone();
    let repo_entities = repo.clone();
    std::thread::spawn(move || {
        let res = migration::identify_entities(&migration_clone, &repo_entities);
        let _ = tx_clone.send(DataFlowMsg::Entities(res));
        ctx_clone.request_repaint();
    });
    let ctx_clone2 = ctx.clone();
    let migration_clone2 = migration.clone();
    std::thread::spawn(move || {
        let res = migration::analyze_data_flows(&migration_clone2, &repo);
        let _ = tx.send(DataFlowMsg::Pipelines(res));
        ctx_clone2.request_repaint();
    });
}

fn drain_dataflow_msgs(runtime: &mut RuntimeState, _ctx: &egui::Context) {
    let Some(rx) = runtime.repo_intel.dataflow_rx.as_ref() else {
        return;
    };
    let mut ent_done = runtime.repo_intel.entities.is_some();
    let mut pipe_done = runtime.repo_intel.pipelines.is_some();
    loop {
        match rx.try_recv() {
            Ok(DataFlowMsg::Entities(res)) => {
                match res {
                    Ok(r) => runtime.repo_intel.entities = Some(r),
                    Err(e) => runtime.repo_intel.dataflow_error = Some(e),
                }
                ent_done = true;
            }
            Ok(DataFlowMsg::Pipelines(res)) => {
                match res {
                    Ok(r) => runtime.repo_intel.pipelines = Some(r),
                    Err(e) => runtime.repo_intel.dataflow_error = Some(e),
                }
                pipe_done = true;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                runtime.repo_intel.dataflow_rx = None;
                runtime.repo_intel.dataflow_tx_keep_alive = None;
                break;
            }
        }
    }
    if ent_done && pipe_done {
        runtime.repo_intel.dataflow_loading = false;
        runtime.repo_intel.dataflow_rx = None;
        runtime.repo_intel.dataflow_tx_keep_alive = None;
    }
}

// ─── Search tab ─────────────────────────────────────────────────────────────

pub fn search_tab(ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    let repo_root = state
        .active_workspace()
        .and_then(|w| w.repo_root.clone());

    let Some(repo_root) = repo_root else {
        ui.vertical_centered(|ui| {
            ui.add_space(40.0);
            ui.label(
                egui::RichText::new("No repository open")
                    .color(p.text_muted)
                    .size(13.0),
            );
        });
        return;
    };

    drain_search_msgs(runtime, ui.ctx());

    egui::Frame::NONE
        .inner_margin(egui::Margin::symmetric(16, 12))
        .show(ui, |ui| {
            // Query input + mode toggles
            ui.horizontal(|ui| {
                let resp = ui.add_sized(
                    [ui.available_width() - 260.0, 26.0],
                    egui::TextEdit::singleline(&mut runtime.repo_intel.search_query)
                        .hint_text("Search repository..."),
                );
                let enter_pressed =
                    resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if resp.changed() {
                    runtime.repo_intel.search_last_edit_at = Some(Instant::now());
                }
                if enter_pressed {
                    dispatch_search(runtime, &repo_root, ui.ctx());
                }

                ui.add_space(8.0);
                ui.label(egui::RichText::new("Mode:").size(11.0).color(p.text_muted));
                for mode in [SearchMode::Hybrid, SearchMode::Lexical, SearchMode::Semantic] {
                    let selected = runtime.repo_intel.search_mode == mode;
                    if ui
                        .selectable_label(
                            selected,
                            egui::RichText::new(mode.as_str()).size(11.0),
                        )
                        .clicked()
                    {
                        runtime.repo_intel.search_mode = mode;
                        runtime.repo_intel.search_last_edit_at = Some(Instant::now());
                    }
                }
            });

            // Debounced auto-dispatch (~200ms)
            let should_auto_dispatch = runtime
                .repo_intel
                .search_last_edit_at
                .map(|t| t.elapsed() > Duration::from_millis(200))
                .unwrap_or(false)
                && !runtime.repo_intel.search_query.trim().is_empty()
                && runtime.repo_intel.search_query != runtime.repo_intel.last_dispatched_query
                && !runtime.repo_intel.search_in_flight;
            if should_auto_dispatch {
                dispatch_search(runtime, &repo_root, ui.ctx());
            }
            // Ensure we wake up to re-check the debounce.
            if runtime.repo_intel.search_last_edit_at.is_some() {
                ui.ctx().request_repaint_after(Duration::from_millis(120));
            }

            ui.add_space(8.0);
            if runtime.repo_intel.search_in_flight {
                ui.label(
                    egui::RichText::new("Searching...")
                        .size(11.0)
                        .color(p.text_muted),
                );
            }
            if let Some(ref err) = runtime.repo_intel.search_error {
                ui.label(egui::RichText::new(err).size(11.0).color(p.error));
            }

            ui.separator();
            ui.add_space(4.0);

            // Keyboard navigation
            let result_count = runtime.repo_intel.search_results.len();
            ui.input(|i| {
                if i.key_pressed(egui::Key::ArrowDown) && result_count > 0 {
                    runtime.repo_intel.search_selected =
                        (runtime.repo_intel.search_selected + 1).min(result_count - 1);
                }
                if i.key_pressed(egui::Key::ArrowUp) && result_count > 0 {
                    runtime.repo_intel.search_selected =
                        runtime.repo_intel.search_selected.saturating_sub(1);
                }
            });

            let results = runtime.repo_intel.search_results.clone();
            let selected_idx = runtime.repo_intel.search_selected;
            let mut open_path: Option<String> = None;

            egui::ScrollArea::vertical().show(ui, |ui| {
                if results.is_empty() && !runtime.repo_intel.search_in_flight {
                    ui.add_space(16.0);
                    ui.label(
                        egui::RichText::new(
                            "Type a query and press Enter (or wait) to search.",
                        )
                        .size(11.0)
                        .color(p.text_muted),
                    );
                }
                for (i, r) in results.iter().enumerate() {
                    let is_selected = i == selected_idx;
                    let fill = if is_selected {
                        p.primary.linear_multiply(0.18)
                    } else {
                        egui::Color32::TRANSPARENT
                    };
                    let frame = egui::Frame::NONE
                        .fill(fill)
                        .corner_radius(CornerRadius::same(4))
                        .inner_margin(egui::Margin::symmetric(8, 6));

                    let inner = frame.show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new(&r.file_path)
                                    .size(12.0)
                                    .color(p.text)
                                    .strong(),
                            );
                            ui.label(
                                egui::RichText::new(format!("  ({})", r.language))
                                    .size(10.0)
                                    .color(p.text_muted),
                            );
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.label(
                                        egui::RichText::new(format!("score {:.2}", r.score))
                                            .size(10.0)
                                            .color(p.text_muted),
                                    );
                                },
                            );
                        });
                        ui.add_space(2.0);
                        ui.label(
                            egui::RichText::new(r.snippet.trim())
                                .size(11.0)
                                .color(p.text_secondary)
                                .family(egui::FontFamily::Monospace),
                        );
                    });

                    let row_resp = inner.response.interact(egui::Sense::click());
                    if row_resp.clicked() {
                        runtime.repo_intel.search_selected = i;
                        open_path = Some(r.file_path.clone());
                    }
                }
            });

            // Enter on selected → open.
            let enter_on_result = ui.input(|i| i.key_pressed(egui::Key::Enter));
            if enter_on_result {
                if let Some(r) = runtime.repo_intel.search_results.get(selected_idx) {
                    open_path = Some(r.file_path.clone());
                }
            }

            if let Some(p) = open_path {
                runtime.repo_intel.pending_open_path = Some(p);
            }
        });
}

fn dispatch_search(runtime: &mut RuntimeState, repo_root: &str, ctx: &egui::Context) {
    let query = runtime.repo_intel.search_query.trim().to_string();
    if query.is_empty() {
        return;
    }
    let Some(migration) = runtime.repo_intel.ensure_migration(Some(repo_root)) else {
        runtime.repo_intel.search_error =
            Some("Migration state unavailable".to_string());
        return;
    };
    let mode = runtime.repo_intel.search_mode;
    let (tx, rx) = mpsc::channel::<SearchResponse>();
    runtime.repo_intel.search_rx = Some(rx);
    runtime.repo_intel.search_tx_keep_alive = Some(tx.clone());
    runtime.repo_intel.last_dispatched_query = query.clone();
    runtime.repo_intel.search_in_flight = true;
    runtime.repo_intel.search_error = None;

    let ctx_clone = ctx.clone();
    let repo = repo_root.to_string();
    std::thread::spawn(move || {
        let q = SearchQuery {
            repo_path: repo,
            text: query.clone(),
            path: None,
            language: None,
            query_type: Some(mode.as_str().to_string()),
            max_tokens: None,
        };
        let opts = SearchOptions { limit: Some(50) };
        let results = migration::search_repository(&migration, &q, Some(&opts));
        let _ = tx.send(SearchResponse {
            query,
            results,
        });
        ctx_clone.request_repaint();
    });
}

fn drain_search_msgs(runtime: &mut RuntimeState, _ctx: &egui::Context) {
    let Some(rx) = runtime.repo_intel.search_rx.as_ref() else {
        return;
    };
    loop {
        match rx.try_recv() {
            Ok(resp) => {
                if resp.query == runtime.repo_intel.last_dispatched_query {
                    match resp.results {
                        Ok(results) => {
                            runtime.repo_intel.search_results = results;
                            runtime.repo_intel.search_selected = 0;
                            runtime.repo_intel.search_error = None;
                        }
                        Err(e) => {
                            runtime.repo_intel.search_error = Some(e);
                            runtime.repo_intel.search_results.clear();
                        }
                    }
                }
                runtime.repo_intel.search_in_flight = false;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => {
                runtime.repo_intel.search_rx = None;
                runtime.repo_intel.search_tx_keep_alive = None;
                runtime.repo_intel.search_in_flight = false;
                break;
            }
        }
    }
}

// ─── Dependency graph tab ───────────────────────────────────────────────────

pub fn dep_graph_tab(ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();

    let repo_root = state
        .active_workspace()
        .and_then(|w| w.repo_root.clone());
    if let Some(ref root) = repo_root {
        load_graph_if_needed(runtime, root, ui.ctx());
    }
    drain_graph_msgs(runtime, ui.ctx());

    egui::Frame::NONE
        .inner_margin(egui::Margin::symmetric(12, 12))
        .show(ui, |ui| {
            // Toolbar / filters
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("Dependency Graph")
                        .size(14.0)
                        .color(p.text)
                        .strong(),
                );
                if let Some(ref g) = runtime.repo_intel.graph {
                    ui.label(
                        egui::RichText::new(format!(
                            "{} nodes, {} edges",
                            g.nodes.len(),
                            g.edges.len()
                        ))
                        .size(11.0)
                        .color(p.text_muted),
                    );
                }
                if runtime.repo_intel.graph_loading {
                    ui.label(
                        egui::RichText::new("Loading...")
                            .size(11.0)
                            .color(p.text_muted),
                    );
                }
                if let Some(ref err) = runtime.repo_intel.graph_error {
                    ui.label(egui::RichText::new(err).size(11.0).color(p.error));
                }
            });

            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Folder:").size(11.0).color(p.text_muted));
                ui.add_sized(
                    [160.0, 22.0],
                    egui::TextEdit::singleline(&mut state.repo_intel_filters.folder)
                        .hint_text("src/"),
                );
                ui.add_space(12.0);
                ui.label(
                    egui::RichText::new("Min edges:")
                        .size(11.0)
                        .color(p.text_muted),
                );
                ui.add(
                    egui::Slider::new(&mut state.repo_intel_filters.min_edges, 0..=20)
                        .integer(),
                );
                ui.add_space(12.0);
                if ui
                    .button(egui::RichText::new("Reset view").size(11.0))
                    .clicked()
                {
                    runtime.repo_intel.graph_view =
                        crate::state::repo_intel::GraphView::default();
                }
            });

            // Language filter chips
            let langs: Vec<String> = {
                let mut v: Vec<String> = runtime
                    .repo_intel
                    .graph
                    .as_ref()
                    .map(|g| {
                        let mut set = std::collections::HashSet::<String>::new();
                        for n in &g.nodes {
                            if let Some(lang) = &n.language {
                                set.insert(lang.clone());
                            }
                        }
                        set.into_iter().collect()
                    })
                    .unwrap_or_default();
                v.sort();
                v
            };
            if !langs.is_empty() {
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        egui::RichText::new("Languages:")
                            .size(11.0)
                            .color(p.text_muted),
                    );
                    for lang in &langs {
                        let active =
                            state.repo_intel_filters.languages.contains(lang);
                        if ui
                            .selectable_label(
                                active,
                                egui::RichText::new(lang).size(10.0),
                            )
                            .clicked()
                        {
                            if active {
                                state
                                    .repo_intel_filters
                                    .languages
                                    .retain(|l| l != lang);
                            } else {
                                state
                                    .repo_intel_filters
                                    .languages
                                    .push(lang.clone());
                            }
                        }
                    }
                });
            }

            ui.separator();
            ui.add_space(4.0);

            // Canvas
            let canvas_size = ui.available_size();
            let (rect, resp) =
                ui.allocate_exact_size(canvas_size, egui::Sense::click_and_drag());
            let painter = ui.painter_at(rect);

            painter.rect_filled(rect, 0, p.editor_bg);

            // Handle pan
            if resp.dragged() {
                runtime.repo_intel.graph_view.offset_x += resp.drag_delta().x;
                runtime.repo_intel.graph_view.offset_y += resp.drag_delta().y;
            }
            // Handle zoom
            let scroll = ui.input(|i| i.smooth_scroll_delta.y);
            if resp.hovered() && scroll.abs() > 0.01 {
                let factor = (1.0 + scroll * 0.002).clamp(0.5, 1.5);
                runtime.repo_intel.graph_view.zoom =
                    (runtime.repo_intel.graph_view.zoom * factor).clamp(0.1, 5.0);
            }

            if let (Some(graph), Some(layout)) = (
                runtime.repo_intel.graph.as_ref(),
                runtime.repo_intel.graph_layout.as_ref(),
            ) {
                let pos_map: std::collections::HashMap<&str, (f32, f32)> = layout
                    .positions
                    .iter()
                    .map(|(id, pos)| (id.as_str(), (pos.x, pos.y)))
                    .collect();

                // Degree map for filter.
                let mut degrees: std::collections::HashMap<&str, u32> =
                    std::collections::HashMap::new();
                for e in &graph.edges {
                    *degrees.entry(e.source.as_str()).or_insert(0) += 1;
                    *degrees.entry(e.target.as_str()).or_insert(0) += 1;
                }

                let node_visible = |node: &GraphNode| -> bool {
                    if !state.repo_intel_filters.languages.is_empty() {
                        if let Some(lang) = &node.language {
                            if !state.repo_intel_filters.languages.contains(lang) {
                                return false;
                            }
                        }
                    }
                    if !state.repo_intel_filters.folder.is_empty() {
                        if let Some(fp) = &node.file_path {
                            if !fp.contains(&state.repo_intel_filters.folder) {
                                return false;
                            }
                        }
                    }
                    let d = *degrees.get(node.id.as_str()).unwrap_or(&0);
                    if d < state.repo_intel_filters.min_edges {
                        return false;
                    }
                    true
                };

                let center = rect.center();
                let zoom = runtime.repo_intel.graph_view.zoom;
                let off =
                    egui::vec2(runtime.repo_intel.graph_view.offset_x, runtime.repo_intel.graph_view.offset_y);
                let to_screen = |(x, y): (f32, f32)| -> egui::Pos2 {
                    center + egui::vec2(x * zoom, y * zoom) + off
                };

                // Draw edges first
                let edge_color = p.border;
                let mut drawn_nodes: std::collections::HashSet<&str> =
                    std::collections::HashSet::new();
                let node_by_id: std::collections::HashMap<&str, &GraphNode> = graph
                    .nodes
                    .iter()
                    .map(|n| (n.id.as_str(), n))
                    .collect();

                for edge in &graph.edges {
                    let Some(src_node) = node_by_id.get(edge.source.as_str()) else {
                        continue;
                    };
                    let Some(tgt_node) = node_by_id.get(edge.target.as_str()) else {
                        continue;
                    };
                    if !node_visible(src_node) || !node_visible(tgt_node) {
                        continue;
                    }
                    if let (Some(&s), Some(&t)) = (
                        pos_map.get(edge.source.as_str()),
                        pos_map.get(edge.target.as_str()),
                    ) {
                        let sp = to_screen(s);
                        let tp = to_screen(t);
                        if !rect.contains(sp) && !rect.contains(tp) {
                            continue;
                        }
                        painter.line_segment([sp, tp], egui::Stroke::new(0.5, edge_color));
                    }
                }

                // Draw nodes
                let hover_pos = resp.hover_pos();
                let mut hover_node: Option<&GraphNode> = None;
                let mut click_target: Option<String> = None;
                for node in &graph.nodes {
                    if !node_visible(node) {
                        continue;
                    }
                    let Some(&xy) = pos_map.get(node.id.as_str()) else {
                        continue;
                    };
                    let sp = to_screen(xy);
                    if !rect.expand(20.0).contains(sp) {
                        continue;
                    }
                    let color = lang_color(node.language.as_deref(), p);
                    let radius = (3.0 + (zoom).min(2.0)).max(2.0);
                    painter.circle_filled(sp, radius, color);

                    drawn_nodes.insert(node.id.as_str());

                    if let Some(hp) = hover_pos {
                        if (hp - sp).length() < radius + 2.0 {
                            hover_node = Some(node);
                            if resp.clicked() {
                                if let Some(fp) = &node.file_path {
                                    click_target = Some(fp.clone());
                                }
                            }
                        }
                    }
                }

                if let Some(node) = hover_node {
                    if let Some(fp) = &node.file_path {
                        egui::show_tooltip_at_pointer(
                            ui.ctx(),
                            ui.layer_id(),
                            egui::Id::new("depgraph_tooltip"),
                            |ui| {
                                ui.label(
                                    egui::RichText::new(fp).size(11.0).color(p.text),
                                );
                                if let Some(lang) = &node.language {
                                    ui.label(
                                        egui::RichText::new(lang)
                                            .size(10.0)
                                            .color(p.text_muted),
                                    );
                                }
                            },
                        );
                    }
                }

                if let Some(path) = click_target {
                    runtime.repo_intel.pending_open_path = Some(path);
                }

                // Legend
                let legend_pos = rect.left_bottom() + egui::vec2(8.0, -8.0);
                let mut langs_sorted: Vec<&String> = runtime
                    .repo_intel
                    .graph
                    .as_ref()
                    .map(|g| {
                        let mut set = std::collections::HashSet::<&String>::new();
                        for n in &g.nodes {
                            if let Some(l) = &n.language {
                                set.insert(l);
                            }
                        }
                        set.into_iter().collect()
                    })
                    .unwrap_or_default();
                langs_sorted.sort();
                let mut y = legend_pos.y - (langs_sorted.len() as f32) * 14.0;
                for lang in langs_sorted.iter().take(8) {
                    let c = lang_color(Some(lang), p);
                    painter.circle_filled(egui::pos2(legend_pos.x + 6.0, y), 4.0, c);
                    painter.text(
                        egui::pos2(legend_pos.x + 16.0, y),
                        egui::Align2::LEFT_CENTER,
                        lang.as_str(),
                        egui::FontId::proportional(10.0),
                        p.text_muted,
                    );
                    y += 14.0;
                }
            } else if !runtime.repo_intel.graph_loading {
                painter.text(
                    rect.center(),
                    egui::Align2::CENTER_CENTER,
                    "No graph data. Run a scan first.",
                    egui::FontId::proportional(13.0),
                    p.text_muted,
                );
            }
        });
}

fn lang_color(lang: Option<&str>, p: ThemePalette) -> egui::Color32 {
    match lang.unwrap_or("") {
        "rust" => egui::Color32::from_rgb(222, 165, 132),
        "typescript" | "tsx" => egui::Color32::from_rgb(49, 120, 198),
        "javascript" | "jsx" => egui::Color32::from_rgb(247, 223, 30),
        "python" => egui::Color32::from_rgb(53, 114, 165),
        "go" => egui::Color32::from_rgb(0, 173, 216),
        "json" => egui::Color32::from_rgb(200, 200, 200),
        "markdown" | "md" => egui::Color32::from_rgb(120, 120, 180),
        "css" | "scss" => egui::Color32::from_rgb(200, 80, 192),
        "html" => egui::Color32::from_rgb(228, 77, 38),
        "yaml" | "yml" | "toml" => egui::Color32::from_rgb(180, 140, 80),
        _ => p.text_secondary,
    }
}

// ─── Data flow tab ──────────────────────────────────────────────────────────

pub fn data_flow_tab(ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState) {
    let p = state.theme.palette();
    let repo_root = state
        .active_workspace()
        .and_then(|w| w.repo_root.clone());
    if let Some(ref root) = repo_root {
        load_dataflow_if_needed(runtime, root, ui.ctx());
    }
    drain_dataflow_msgs(runtime, ui.ctx());

    egui::Frame::NONE
        .inner_margin(egui::Margin::symmetric(12, 12))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("Entities & Data Flow")
                        .size(14.0)
                        .color(p.text)
                        .strong(),
                );
                if runtime.repo_intel.dataflow_loading {
                    ui.label(
                        egui::RichText::new("Analyzing (LLM) ...")
                            .size(11.0)
                            .color(p.text_muted),
                    );
                }
                if let Some(ref err) = runtime.repo_intel.dataflow_error {
                    ui.label(egui::RichText::new(err).size(11.0).color(p.error));
                }
            });

            ui.separator();

            ui.columns(2, |cols| {
                // Left: entity categories
                cols[0].label(
                    egui::RichText::new("Entity categories")
                        .size(12.0)
                        .color(p.text)
                        .strong(),
                );
                cols[0].add_space(4.0);
                if let Some(ref ent) = runtime.repo_intel.entities.clone() {
                    egui::ScrollArea::vertical()
                        .id_salt("entities_scroll")
                        .show(&mut cols[0], |ui| {
                            for cat in &ent.categories {
                                let selected = runtime
                                    .repo_intel
                                    .selected_entity_category
                                    .as_deref()
                                    == Some(cat.category.as_str());
                                let header = format!(
                                    "{} ({})",
                                    cat.category,
                                    cat.file_paths.len()
                                );
                                let resp = ui.selectable_label(
                                    selected,
                                    egui::RichText::new(header).size(11.0),
                                );
                                if resp.clicked() {
                                    runtime.repo_intel.selected_entity_category =
                                        Some(cat.category.clone());
                                }
                                if selected {
                                    ui.indent(egui::Id::new(&cat.category), |ui| {
                                        ui.label(
                                            egui::RichText::new(&cat.description)
                                                .size(10.0)
                                                .color(p.text_muted),
                                        );
                                        for fp in &cat.file_paths {
                                            if ui
                                                .add(
                                                    egui::Button::new(
                                                        egui::RichText::new(fp)
                                                            .size(10.0)
                                                            .color(p.text_secondary),
                                                    )
                                                    .frame(false),
                                                )
                                                .clicked()
                                            {
                                                runtime
                                                    .repo_intel
                                                    .pending_open_path =
                                                    Some(fp.clone());
                                            }
                                        }
                                    });
                                }
                            }
                            if !ent.uncategorized.is_empty() {
                                ui.separator();
                                ui.label(
                                    egui::RichText::new(format!(
                                        "Uncategorized: {}",
                                        ent.uncategorized.len()
                                    ))
                                    .size(10.0)
                                    .color(p.text_muted),
                                );
                            }
                        });
                } else if !runtime.repo_intel.dataflow_loading {
                    cols[0].label(
                        egui::RichText::new(
                            "Entities require an LLM provider configured (BYOK).",
                        )
                        .size(11.0)
                        .color(p.text_muted),
                    );
                }

                // Right: data pipelines
                cols[1].label(
                    egui::RichText::new("Data pipelines")
                        .size(12.0)
                        .color(p.text)
                        .strong(),
                );
                cols[1].add_space(4.0);
                if let Some(ref df) = runtime.repo_intel.pipelines.clone() {
                    cols[1].label(
                        egui::RichText::new(&df.summary)
                            .size(10.0)
                            .color(p.text_muted),
                    );
                    cols[1].separator();
                    egui::ScrollArea::vertical()
                        .id_salt("pipelines_scroll")
                        .show(&mut cols[1], |ui| {
                            for pipe in &df.pipelines {
                                let expanded = runtime
                                    .repo_intel
                                    .selected_pipeline
                                    .as_deref()
                                    == Some(pipe.id.as_str());
                                let header = format!(
                                    "{} ({} steps, conf {:.2})",
                                    pipe.name,
                                    pipe.steps.len(),
                                    pipe.confidence
                                );
                                if ui
                                    .selectable_label(
                                        expanded,
                                        egui::RichText::new(header).size(11.0),
                                    )
                                    .clicked()
                                {
                                    runtime.repo_intel.selected_pipeline =
                                        Some(pipe.id.clone());
                                }
                                if expanded {
                                    ui.indent(egui::Id::new(&pipe.id), |ui| {
                                        ui.label(
                                            egui::RichText::new(&pipe.description)
                                                .size(10.0)
                                                .color(p.text_muted),
                                        );
                                        for step in &pipe.steps {
                                            ui.horizontal(|ui| {
                                                let role_color = match step
                                                    .role
                                                    .as_str()
                                                {
                                                    "source" => p.success,
                                                    "sink" => p.warning,
                                                    "transform" => p.info,
                                                    _ => p.text_muted,
                                                };
                                                ui.label(
                                                    egui::RichText::new(format!(
                                                        "[{}]",
                                                        step.role
                                                    ))
                                                    .size(10.0)
                                                    .color(role_color),
                                                );
                                                if ui
                                                    .add(
                                                        egui::Button::new(
                                                            egui::RichText::new(
                                                                &step.file_path,
                                                            )
                                                            .size(10.0)
                                                            .color(p.text_secondary),
                                                        )
                                                        .frame(false),
                                                    )
                                                    .clicked()
                                                {
                                                    runtime
                                                        .repo_intel
                                                        .pending_open_path = Some(
                                                        step.file_path.clone(),
                                                    );
                                                }
                                            });
                                            ui.label(
                                                egui::RichText::new(
                                                    &step.description,
                                                )
                                                .size(10.0)
                                                .color(p.text_muted),
                                            );
                                            ui.add_space(4.0);
                                        }
                                    });
                                }
                            }
                        });
                } else if !runtime.repo_intel.dataflow_loading {
                    cols[1].label(
                        egui::RichText::new(
                            "Data flows require an LLM provider configured (BYOK).",
                        )
                        .size(11.0)
                        .color(p.text_muted),
                    );
                }
            });
        });
}

/// Called once per frame from the center panel to turn any queued
/// "please open this file" request into an actual tab.
pub fn process_pending_open(runtime: &mut RuntimeState, repo_root: Option<&str>) {
    let Some(path_str) = runtime.repo_intel.pending_open_path.take() else {
        return;
    };
    let mut pb = PathBuf::from(&path_str);
    if pb.is_relative() {
        if let Some(root) = repo_root {
            pb = PathBuf::from(root).join(pb);
        }
    }
    if pb.exists() && pb.is_file() {
        runtime.open_file(&pb);
    }
}

// Silence unused-import lint if MigrationState is moved around.
#[allow(dead_code)]
fn _force_use(_: &MigrationState) {}

#[allow(dead_code)]
fn _force_use_result(_: &SearchResult) {}
