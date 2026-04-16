pub mod agents;
pub mod agents_parse;
pub mod persistence;
pub mod rail_deck;
pub mod repo_intel;
pub mod sessions;
pub mod sessions_worker;
pub mod toasts;
pub mod workspaces;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::theme::Theme;

pub use agents::{AgentsRuntime, PersistedAgentsState};
pub use rail_deck::{LogSource, RailCardKind, RailCardMeta, RailCardState, RailDeck};
pub use repo_intel::{RepoIntelState, RepoIntelFilters};
pub use sessions::{
    ChecksSummary, DeltaCount, Mergeable, PrState, PullRequestInfo, Session, SessionStatus,
    SessionsRegistry, TokenUsage,
};
pub use toasts::{Toast, ToastQueue, ToastVariant};
pub use workspaces::{Remote, Repository};

// ─── Git panel sub-tabs ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitSubTab {
    Changes,
    Branches,
    Worktrees,
    Log,
    PRs,
}

impl GitSubTab {
    pub const ALL: &[GitSubTab] = &[
        GitSubTab::Changes,
        GitSubTab::Branches,
        GitSubTab::Worktrees,
        GitSubTab::Log,
        GitSubTab::PRs,
    ];

    pub fn label(&self) -> &str {
        match self {
            GitSubTab::Changes => "Changes",
            GitSubTab::Branches => "Branches",
            GitSubTab::Worktrees => "Worktrees",
            GitSubTab::Log => "Log",
            GitSubTab::PRs => "PRs",
        }
    }
}

// ─── Git panel state (runtime, not persisted) ───────────────────────────────

pub struct GitPanelState {
    pub sub_tab: GitSubTab,

    // Cached data
    pub file_statuses: Vec<voidlink_core::git::GitFileStatus>,
    pub branches: Vec<voidlink_core::git::GitBranchInfo>,
    pub worktrees: Vec<voidlink_core::git::WorktreeInfo>,
    pub log: Vec<voidlink_core::git::GitCommitInfo>,
    pub prs: Vec<voidlink_core::git_review::PullRequestInfo>,
    pub audit_log: Vec<voidlink_core::git_review::AuditEntry>,
    pub repo_info: Option<voidlink_core::git::GitRepoInfo>,

    // Diff state
    pub selected_diff_path: Option<String>,
    pub diff_result: Option<voidlink_core::git::DiffResult>,
    pub selected_commit_oid: Option<String>,
    pub commit_diff: Option<voidlink_core::git::DiffResult>,

    // Commit compose
    pub commit_message: String,

    // Worktree creation
    pub new_wt_branch: String,
    pub new_wt_base: String,

    // Freshness
    pub needs_refresh: bool,
    pub last_refresh_frame: u64,

    // Error/status feedback
    pub status_message: Option<(String, bool)>, // (message, is_error)
}

impl Default for GitPanelState {
    fn default() -> Self {
        Self {
            sub_tab: GitSubTab::Changes,
            file_statuses: Vec::new(),
            branches: Vec::new(),
            worktrees: Vec::new(),
            log: Vec::new(),
            prs: Vec::new(),
            audit_log: Vec::new(),
            repo_info: None,
            selected_diff_path: None,
            diff_result: None,
            selected_commit_oid: None,
            commit_diff: None,
            commit_message: String::new(),
            new_wt_branch: String::new(),
            new_wt_base: String::from("HEAD"),
            needs_refresh: true,
            last_refresh_frame: 0,
            status_message: None,
        }
    }
}

// ─── Bottom pane tabs ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BottomTab {
    Terminal,
    Git,
    Logs,
}

impl BottomTab {
    pub const ALL: &[BottomTab] = &[BottomTab::Terminal, BottomTab::Git, BottomTab::Logs];

    pub fn label(&self) -> &str {
        match self {
            BottomTab::Terminal => "Terminal",
            BottomTab::Git => "Git",
            BottomTab::Logs => "Logs",
        }
    }
}

// ─── Sidebar pages ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SidebarPage {
    Explorer,
    Search,
    Git,
    Notes,
    /// Agents page. Aliased to `Agent` for backward-compat with persisted
    /// state from earlier builds where the variant was singular.
    #[serde(alias = "Agent")]
    Agents,
    Repo,
}

impl SidebarPage {
    pub const ALL: &[SidebarPage] = &[
        SidebarPage::Explorer,
        SidebarPage::Search,
        SidebarPage::Git,
        SidebarPage::Notes,
        SidebarPage::Repo,
        SidebarPage::Agents,
    ];

    pub fn icon(&self) -> &str {
        match self {
            SidebarPage::Explorer => "\u{1F4C1}",  // folder
            SidebarPage::Search => "\u{1F50D}",    // magnifying glass
            SidebarPage::Git => "\u{2442}",         // branch symbol
            SidebarPage::Notes => "\u{1F4DD}",     // memo
            SidebarPage::Agents => "\u{1F916}",     // robot face
            SidebarPage::Repo => "\u{1F9E0}",      // brain (Repository Intelligence)
        }
    }

    pub fn label(&self) -> &str {
        match self {
            SidebarPage::Explorer => "Explorer",
            SidebarPage::Search => "Search",
            SidebarPage::Git => "Git",
            SidebarPage::Notes => "Notes",
            SidebarPage::Agents => "Agents",
            SidebarPage::Repo => "Repository",
        }
    }
}

// ─── Workspace ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// LEGACY v1 field. Pre-ED-E builds stored a single repo path here. New
    /// builds migrate this into `repository_ids` on first load; the field is
    /// preserved (`#[serde(default)]`) so v1 state.json files keep loading.
    #[serde(default)]
    pub repo_root: Option<String>,
    /// ED-E: canonical list of repository ids belonging to this workspace.
    #[serde(default)]
    pub repository_ids: Vec<String>,
    /// ED-E: pinned session ids (Codex-style "Pinned" section).
    #[serde(default)]
    pub pinned_session_ids: Vec<String>,
    /// ED-E: recent session LRU, capped to 16 entries.
    #[serde(default)]
    pub recent_session_ids: Vec<String>,
}

impl Workspace {
    pub fn new(name: &str) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            repo_root: None,
            repository_ids: Vec::new(),
            pinned_session_ids: Vec::new(),
            recent_session_ids: Vec::new(),
        }
    }
}

// ─── Layout state ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutState {
    pub left_sidebar_width: f32,
    pub left_sidebar_open: bool,
    pub right_sidebar_width: f32,
    pub right_sidebar_open: bool,
    pub bottom_pane_height: f32,
    pub bottom_pane_open: bool,
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            left_sidebar_width: 240.0,
            left_sidebar_open: true,
            right_sidebar_width: 260.0,
            right_sidebar_open: false,
            bottom_pane_height: 220.0,
            bottom_pane_open: false,
        }
    }
}

// ─── Full app state ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub theme: Theme,
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: String,
    pub layout: LayoutState,
    pub sidebar_page: SidebarPage,
    pub bottom_tab: BottomTab,
    #[serde(default)]
    pub repo_intel_filters: RepoIntelFilters,
    #[serde(default)]
    pub last_scan_at_ms: Option<i64>,
    /// Persisted agent metadata (§3.4.1). Event history is NOT persisted.
    #[serde(default)]
    pub agents: PersistedAgentsState,
    /// ED-G user-visible fx preference (Solid / Soft / Full).
    #[serde(default)]
    pub fx_preference: crate::fx::FxPreference,
    /// ED-E: all repositories across workspaces, keyed by id. Workspaces
    /// reference repos via `Workspace.repository_ids`.
    #[serde(default)]
    pub repositories: std::collections::HashMap<String, Repository>,
    /// ED-E: all sessions across workspaces.
    #[serde(default)]
    pub sessions: SessionsRegistry,
    /// ED-E: active session id per workspace (None ⇒ show repo overview).
    #[serde(default)]
    pub active_session_by_workspace: std::collections::HashMap<String, String>,
}

impl Default for AppState {
    fn default() -> Self {
        let default_workspace = Workspace::new("Default");
        let id = default_workspace.id.clone();
        Self {
            theme: Theme::Dark,
            workspaces: vec![default_workspace],
            active_workspace_id: id,
            layout: LayoutState::default(),
            sidebar_page: SidebarPage::Explorer,
            bottom_tab: BottomTab::Terminal,
            repo_intel_filters: RepoIntelFilters::default(),
            last_scan_at_ms: None,
            agents: PersistedAgentsState::default(),
            fx_preference: crate::fx::FxPreference::default(),
            repositories: std::collections::HashMap::new(),
            sessions: SessionsRegistry::default(),
            active_session_by_workspace: std::collections::HashMap::new(),
        }
    }
}

impl AppState {
    pub fn active_workspace(&self) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == self.active_workspace_id)
    }

    pub fn active_workspace_mut(&mut self) -> Option<&mut Workspace> {
        let id = self.active_workspace_id.clone();
        self.workspaces.iter_mut().find(|w| w.id == id)
    }

    pub fn add_workspace(&mut self, name: &str) -> String {
        let ws = Workspace::new(name);
        let id = ws.id.clone();
        self.workspaces.push(ws);
        self.active_workspace_id = id.clone();
        id
    }

    pub fn delete_workspace(&mut self, id: &str) {
        if self.workspaces.len() <= 1 {
            return; // keep at least one
        }
        self.workspaces.retain(|w| w.id != id);
        if self.active_workspace_id == id {
            if let Some(first) = self.workspaces.first() {
                self.active_workspace_id = first.id.clone();
            }
        }
    }

    pub fn rename_workspace(&mut self, id: &str, new_name: &str) {
        if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == id) {
            ws.name = new_name.to_string();
        }
    }

    /// ED-E v1→v2 migration. Idempotent: runs on every load and does nothing
    /// if the workspace already has at least one repository. Called by
    /// `persistence::load` after deserialising.
    ///
    /// For every workspace that still carries a legacy `repo_root`:
    ///   1. Create a `Repository` at that path.
    ///   2. Link it via `Workspace.repository_ids`.
    ///   3. Create a default `Session` named `main` under that repository.
    ///   4. Set that session as the workspace's active session.
    ///
    /// The legacy `repo_root` field is preserved for one release as a safety
    /// net — ED-F will delete it outright once we ship a v2-only reader.
    pub fn migrate_workspace_shape(&mut self) {
        let workspace_ids: Vec<String> = self.workspaces.iter().map(|w| w.id.clone()).collect();
        for ws_id in workspace_ids {
            // Snapshot the legacy fields we need so we can mutate ws + registries
            // without re-borrowing.
            let (legacy_repo_root, already_has_repos) = {
                let ws = match self.workspaces.iter().find(|w| w.id == ws_id) {
                    Some(w) => w,
                    None => continue,
                };
                (ws.repo_root.clone(), !ws.repository_ids.is_empty())
            };

            if already_has_repos {
                continue;
            }
            let Some(root) = legacy_repo_root else {
                continue;
            };
            if root.trim().is_empty() {
                continue;
            }

            let repo = Repository::from_path(&ws_id, std::path::PathBuf::from(&root));
            let repo_id = repo.id.clone();
            let default_branch = repo.default_branch.clone();
            self.repositories.insert(repo_id.clone(), repo);

            let session = Session::new(&repo_id, "main", &default_branch, &default_branch);
            let session_id = self.sessions.insert(session);

            if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                ws.repository_ids.push(repo_id);
            }
            self.active_session_by_workspace
                .insert(ws_id, session_id);
        }
    }

    /// ED-E helper — return repositories linked to the active workspace in the
    /// order stored on `Workspace.repository_ids`.
    pub fn active_repositories(&self) -> Vec<&Repository> {
        let Some(ws) = self.active_workspace() else {
            return Vec::new();
        };
        ws.repository_ids
            .iter()
            .filter_map(|id| self.repositories.get(id))
            .collect()
    }
}

// ─── File tree ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
    pub loaded: bool,
}

impl FileNode {
    /// Build a shallow tree node (children not yet loaded for directories).
    pub fn new(path: PathBuf, is_dir: bool) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        Self {
            name,
            path,
            is_dir,
            children: Vec::new(),
            loaded: !is_dir, // files are always "loaded"
        }
    }

    /// Load immediate children of a directory (one level deep).
    pub fn load_children(&mut self) {
        if !self.is_dir || self.loaded {
            return;
        }
        self.loaded = true;
        let mut entries = Vec::new();
        if let Ok(read_dir) = std::fs::read_dir(&self.path) {
            for entry in read_dir.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                entries.push(FileNode::new(entry.path(), is_dir));
            }
        }
        // Sort: directories first, then alphabetical
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        self.children = entries;
    }
}

// ─── Tab system ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum TabKind {
    Welcome,
    File { path: PathBuf },
    Note { id: String },
    Search,
    DepGraph,
    DataFlow,
    /// Autonomous task chat tab — one per task (§3.4.3).
    AgentChat { session_id: String },
    /// Singleton orchestrator tab for external CLI agents (§3.4.3).
    AgentOrchestrator,
    /// Dedicated terminal tab for one CLI-agent PTY session.
    AgentCliTerminal { session_id: String },
}

// ─── Notes system ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub path: PathBuf,
}

pub struct NotesState {
    pub notes: Vec<NoteEntry>,
    /// Whether notes are in edit or preview mode (per note id).
    pub edit_mode: std::collections::HashMap<String, bool>,
    /// CommonMark cache for rendering.
    pub commonmark_cache: egui_commonmark::CommonMarkCache,
    pub needs_refresh: bool,
    /// Slash command popup state.
    pub slash_popup_open: bool,
    pub slash_cursor_pos: Option<usize>,
}

impl Default for NotesState {
    fn default() -> Self {
        Self {
            notes: Vec::new(),
            edit_mode: std::collections::HashMap::new(),
            commonmark_cache: egui_commonmark::CommonMarkCache::default(),
            needs_refresh: true,
            slash_popup_open: false,
            slash_cursor_pos: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tab {
    pub id: String,
    pub label: String,
    pub kind: TabKind,
    pub dirty: bool,
    /// The editor text content (loaded from disk).
    pub content: String,
}

impl Tab {
    pub fn welcome() -> Self {
        Self {
            id: "welcome".to_string(),
            label: "Welcome".to_string(),
            kind: TabKind::Welcome,
            dirty: false,
            content: String::new(),
        }
    }

    pub fn file(path: &Path) -> Self {
        let label = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "untitled".to_string());
        let content = std::fs::read_to_string(path).unwrap_or_default();
        Self {
            id: path.to_string_lossy().to_string(),
            label,
            kind: TabKind::File {
                path: path.to_path_buf(),
            },
            dirty: false,
            content,
        }
    }

    pub fn note(entry: &NoteEntry) -> Self {
        let content = std::fs::read_to_string(&entry.path).unwrap_or_default();
        Self {
            id: format!("note:{}", entry.id),
            label: entry.title.clone(),
            kind: TabKind::Note {
                id: entry.id.clone(),
            },
            dirty: false,
            content,
        }
    }

    pub fn search() -> Self {
        Self {
            id: "repo:search".to_string(),
            label: "Search".to_string(),
            kind: TabKind::Search,
            dirty: false,
            content: String::new(),
        }
    }

    pub fn dep_graph() -> Self {
        Self {
            id: "repo:depgraph".to_string(),
            label: "Dep Graph".to_string(),
            kind: TabKind::DepGraph,
            dirty: false,
            content: String::new(),
        }
    }

    pub fn data_flow() -> Self {
        Self {
            id: "repo:dataflow".to_string(),
            label: "Data Flow".to_string(),
            kind: TabKind::DataFlow,
            dirty: false,
            content: String::new(),
        }
    }

    pub fn agent_chat(session_id: &str, label: &str) -> Self {
        Self {
            id: format!("agent:chat:{}", session_id),
            label: label.to_string(),
            kind: TabKind::AgentChat {
                session_id: session_id.to_string(),
            },
            dirty: false,
            content: String::new(),
        }
    }

    pub fn agent_orchestrator() -> Self {
        Self {
            id: "agent:orchestrator".to_string(),
            label: "Agents".to_string(),
            kind: TabKind::AgentOrchestrator,
            dirty: false,
            content: String::new(),
        }
    }

    pub fn agent_cli(session_id: &str, label: &str) -> Self {
        Self {
            id: format!("agent:cli:{}", session_id),
            label: label.to_string(),
            kind: TabKind::AgentCliTerminal {
                session_id: session_id.to_string(),
            },
            dirty: false,
            content: String::new(),
        }
    }
}

// ─── Terminal sessions ───────────────────────────────────────────────────────

pub struct TerminalSession {
    pub id: u64,
    pub label: String,
    pub backend: egui_term::TerminalBackend,
}

pub struct TerminalManager {
    pub sessions: Vec<TerminalSession>,
    pub active_id: Option<u64>,
    pub next_id: u64,
    pub event_sender: mpsc::Sender<(u64, egui_term::PtyEvent)>,
    pub event_receiver: mpsc::Receiver<(u64, egui_term::PtyEvent)>,
}

impl TerminalManager {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            sessions: Vec::new(),
            active_id: None,
            next_id: 1,
            event_sender: tx,
            event_receiver: rx,
        }
    }

    pub fn spawn(
        &mut self,
        ctx: &eframe::egui::Context,
        cwd: Option<&str>,
    ) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let settings = egui_term::BackendSettings {
            shell,
            args: vec!["-l".to_string(), "-i".to_string()],
            working_directory: cwd.map(PathBuf::from),
        };

        let backend = egui_term::TerminalBackend::new(
            id,
            ctx.clone(),
            self.event_sender.clone(),
            settings,
        )
        .map_err(|e| e.to_string())?;

        let label = format!("Terminal {}", id);
        self.sessions.push(TerminalSession {
            id,
            label,
            backend,
        });
        self.active_id = Some(id);
        Ok(id)
    }

    pub fn close(&mut self, id: u64) {
        self.sessions.retain(|s| s.id != id);
        if self.active_id == Some(id) {
            self.active_id = self.sessions.last().map(|s| s.id);
        }
    }

    pub fn active_session_mut(&mut self) -> Option<&mut TerminalSession> {
        let id = self.active_id?;
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    /// Process pending PTY events (call each frame).
    pub fn poll_events(&mut self) {
        while let Ok((_id, _event)) = self.event_receiver.try_recv() {
            // Events are processed internally by the backend's event loop.
            // We drain the channel to prevent backpressure.
        }
    }

    /// Inject a command string into the active terminal.
    pub fn inject_command(&mut self, cmd: &str) {
        if let Some(session) = self.active_session_mut() {
            session
                .backend
                .process_command(egui_term::BackendCommand::Write(cmd.as_bytes().to_vec()));
        }
    }
}

// ─── Editor state (runtime, not persisted) ───────────────────────────────────

/// Runtime state that is NOT serialized — rebuilt each session.
pub struct RuntimeState {
    pub file_tree: Option<FileNode>,
    pub tabs: Vec<Tab>,
    pub active_tab_id: String,
    /// Set of expanded directory paths in the file tree.
    pub expanded_dirs: HashSet<PathBuf>,
    /// Path being renamed via context menu (None if not renaming).
    pub renaming: Option<PathBuf>,
    pub rename_buf: String,
    /// Context menu target path.
    pub context_menu_path: Option<PathBuf>,
    /// Terminal sessions manager.
    pub terminals: TerminalManager,
    /// Git panel state.
    pub git_panel: GitPanelState,
    /// Notes state.
    pub notes: NotesState,
    /// Repository intelligence state (scan jobs, search, graph, dataflow).
    pub repo_intel: RepoIntelState,
    /// Agent system runtime (chats, CLI sessions, dispatcher channels).
    pub agents: AgentsRuntime,
    /// Transient toast queue (ED-A §4 — `widgets/toast_host.rs`).
    pub toasts: ToastQueue,
    /// ED-C rail-card deck. Runtime-only until ED-E binds a deck per session.
    pub rail_deck: RailDeck,
    /// ED-C feature flag — when true, the right panel renders the new rail-card
    /// deck; when false the legacy context panel renders. Runtime-writable
    /// from Settings; persisted once ED-E lands.
    pub new_shell: bool,
    /// ED-F PR refresh worker. Dispatches `list_prs_impl` / `get_pr_impl`
    /// calls off-thread and posts responses back for the update loop to drain.
    pub pr_worker: sessions_worker::PrWorker,
}

impl Default for RuntimeState {
    fn default() -> Self {
        let welcome = Tab::welcome();
        let id = welcome.id.clone();
        Self {
            file_tree: None,
            tabs: vec![welcome],
            active_tab_id: id,
            expanded_dirs: HashSet::new(),
            renaming: None,
            rename_buf: String::new(),
            context_menu_path: None,
            terminals: TerminalManager::new(),
            git_panel: GitPanelState::default(),
            notes: NotesState::default(),
            repo_intel: RepoIntelState::new(),
            agents: AgentsRuntime::new(),
            toasts: ToastQueue::default(),
            rail_deck: RailDeck::default_deck(),
            // ED-C: default on in debug builds so the new shell is the default
            // dev experience; off in release until we flip the flag globally.
            new_shell: cfg!(debug_assertions),
            pr_worker: sessions_worker::PrWorker::default(),
        }
    }
}

impl RuntimeState {
    /// Initialize file tree from a repo root path.
    pub fn load_tree(&mut self, root: &str) {
        let path = PathBuf::from(root);
        if path.is_dir() {
            let mut node = FileNode::new(path, true);
            node.load_children();
            self.file_tree = Some(node);
        }
    }

    /// Open a file in a tab (or focus it if already open).
    pub fn open_file(&mut self, path: &Path) {
        let key = path.to_string_lossy().to_string();
        // Focus existing tab
        if self.tabs.iter().any(|t| t.id == key) {
            self.active_tab_id = key;
            return;
        }
        // Create new tab
        let tab = Tab::file(path);
        self.active_tab_id = tab.id.clone();
        self.tabs.push(tab);
    }

    pub fn close_tab(&mut self, id: &str) {
        self.tabs.retain(|t| t.id != id);
        if self.active_tab_id == id {
            self.active_tab_id = self.tabs.last().map(|t| t.id.clone()).unwrap_or_default();
        }
        // Always keep at least the welcome tab
        if self.tabs.is_empty() {
            let welcome = Tab::welcome();
            self.active_tab_id = welcome.id.clone();
            self.tabs.push(welcome);
        }
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == self.active_tab_id)
    }

    pub fn active_tab_mut(&mut self) -> Option<&mut Tab> {
        let id = self.active_tab_id.clone();
        self.tabs.iter_mut().find(|t| t.id == id)
    }

    pub fn save_active_tab(&mut self) -> Result<(), String> {
        let id = self.active_tab_id.clone();
        if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == id) {
            match &tab.kind {
                TabKind::File { ref path } => {
                    std::fs::write(path, &tab.content).map_err(|e| e.to_string())?;
                    tab.dirty = false;
                }
                TabKind::Note { ref id } => {
                    if let Some(entry) = self.notes.notes.iter().find(|n| n.id == *id) {
                        std::fs::write(&entry.path, &tab.content)
                            .map_err(|e| e.to_string())?;
                        tab.dirty = false;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Open the Search tab.
    pub fn open_search_tab(&mut self) {
        let id = "repo:search".to_string();
        if self.tabs.iter().any(|t| t.id == id) {
            self.active_tab_id = id;
            return;
        }
        let tab = Tab::search();
        self.active_tab_id = tab.id.clone();
        self.tabs.push(tab);
    }

    /// Open the Dependency Graph tab.
    pub fn open_dep_graph_tab(&mut self) {
        let id = "repo:depgraph".to_string();
        if self.tabs.iter().any(|t| t.id == id) {
            self.active_tab_id = id;
            return;
        }
        let tab = Tab::dep_graph();
        self.active_tab_id = tab.id.clone();
        self.tabs.push(tab);
    }

    /// Open the Data Flow tab.
    pub fn open_data_flow_tab(&mut self) {
        let id = "repo:dataflow".to_string();
        if self.tabs.iter().any(|t| t.id == id) {
            self.active_tab_id = id;
            return;
        }
        let tab = Tab::data_flow();
        self.active_tab_id = tab.id.clone();
        self.tabs.push(tab);
    }

    /// Open a note in a tab (or focus it if already open).
    pub fn open_note(&mut self, entry: &NoteEntry) {
        let key = format!("note:{}", entry.id);
        if self.tabs.iter().any(|t| t.id == key) {
            self.active_tab_id = key;
            return;
        }
        let tab = Tab::note(entry);
        self.active_tab_id = tab.id.clone();
        self.tabs.push(tab);
    }

    /// Load notes from the .voidlink/notes/ directory in the given repo root.
    pub fn load_notes(&mut self, repo_root: &str) {
        let notes_dir = PathBuf::from(repo_root).join(".voidlink").join("notes");
        if !notes_dir.exists() {
            self.notes.notes.clear();
            return;
        }
        let mut entries = Vec::new();
        if let Ok(read_dir) = std::fs::read_dir(&notes_dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    let name = path
                        .file_stem()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let id = name.clone();
                    entries.push(NoteEntry {
                        id,
                        title: name,
                        path,
                    });
                }
            }
        }
        entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        self.notes.notes = entries;
        self.notes.needs_refresh = false;
    }

    /// Create a new note file and return the entry.
    pub fn create_note(&mut self, repo_root: &str, title: &str) -> Result<NoteEntry, String> {
        let notes_dir = PathBuf::from(repo_root).join(".voidlink").join("notes");
        std::fs::create_dir_all(&notes_dir).map_err(|e| e.to_string())?;

        let filename = sanitize_filename(title);
        let path = notes_dir.join(format!("{}.md", filename));
        if path.exists() {
            return Err(format!("Note '{}' already exists", title));
        }

        let initial = format!("# {}\n\n", title);
        std::fs::write(&path, &initial).map_err(|e| e.to_string())?;

        let entry = NoteEntry {
            id: filename.clone(),
            title: title.to_string(),
            path,
        };
        self.notes.notes.push(entry.clone());
        self.notes
            .notes
            .sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(entry)
    }

    /// Delete a note file.
    pub fn delete_note(&mut self, note_id: &str) -> Result<(), String> {
        if let Some(entry) = self.notes.notes.iter().find(|n| n.id == note_id) {
            std::fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
        }
        self.notes.notes.retain(|n| n.id != note_id);
        // Close the tab if open
        let tab_id = format!("note:{}", note_id);
        self.close_tab(&tab_id);
        Ok(())
    }
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}
