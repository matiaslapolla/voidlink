pub mod detect;
pub mod rpc;
pub mod server;

use std::sync::Arc;

use dashmap::DashMap;

pub use detect::{lsp_detect_servers_impl, LspServerInfo};
pub use server::LspServer;

pub struct LspState {
    pub servers: Arc<DashMap<String, LspServer>>,
}

impl LspState {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(DashMap::new()),
        }
    }
}
