//! Toast queue (polish plan §3 — `widgets/toast_host.rs`, backed by this state).
//!
//! Toasts render anchored to the bottom-right corner of the app via a
//! top-layer `egui::Area`. Auto-dismiss after `ttl_seconds` or user click.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastVariant {
    Info,
    Success,
    Warning,
    Error,
}

impl ToastVariant {
    pub fn icon(&self) -> &'static str {
        match self {
            ToastVariant::Info => "\u{2139}",      // ℹ
            ToastVariant::Success => "\u{2714}",   // ✔
            ToastVariant::Warning => "\u{26A0}",   // ⚠
            ToastVariant::Error => "\u{2716}",     // ✖
        }
    }
}

#[derive(Debug, Clone)]
pub struct Toast {
    pub id: u64,
    pub variant: ToastVariant,
    pub title: String,
    pub body: Option<String>,
    pub ttl: Duration,
    pub created_at: Instant,
}

impl Toast {
    pub fn age(&self) -> Duration {
        self.created_at.elapsed()
    }

    pub fn is_expired(&self) -> bool {
        self.age() >= self.ttl
    }

    /// Progress `[0, 1]` from creation to expiry, used by enter/exit animations
    /// and optional progress bars.
    pub fn progress(&self) -> f32 {
        if self.ttl.is_zero() {
            0.0
        } else {
            (self.age().as_secs_f32() / self.ttl.as_secs_f32()).clamp(0.0, 1.0)
        }
    }
}

pub struct ToastQueue {
    pub toasts: Vec<Toast>,
    next_id: u64,
    /// Cap total queued toasts to keep the host bounded.
    pub max_visible: usize,
}

impl Default for ToastQueue {
    fn default() -> Self {
        Self {
            toasts: Vec::new(),
            next_id: 1,
            max_visible: 5,
        }
    }
}

impl ToastQueue {
    /// Push a toast with a custom TTL.
    pub fn push(
        &mut self,
        variant: ToastVariant,
        title: impl Into<String>,
        body: Option<String>,
        ttl: Duration,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.toasts.push(Toast {
            id,
            variant,
            title: title.into(),
            body,
            ttl,
            created_at: Instant::now(),
        });
        // Evict oldest if over cap.
        while self.toasts.len() > self.max_visible {
            self.toasts.remove(0);
        }
        id
    }

    pub fn info(&mut self, title: impl Into<String>) -> u64 {
        self.push(ToastVariant::Info, title, None, Duration::from_secs(4))
    }

    pub fn success(&mut self, title: impl Into<String>) -> u64 {
        self.push(ToastVariant::Success, title, None, Duration::from_secs(3))
    }

    pub fn warning(&mut self, title: impl Into<String>) -> u64 {
        self.push(ToastVariant::Warning, title, None, Duration::from_secs(5))
    }

    pub fn error(&mut self, title: impl Into<String>, body: Option<String>) -> u64 {
        self.push(ToastVariant::Error, title, body, Duration::from_secs(8))
    }

    pub fn dismiss(&mut self, id: u64) {
        self.toasts.retain(|t| t.id != id);
    }

    /// Remove expired toasts. Call once per frame.
    pub fn prune(&mut self) {
        self.toasts.retain(|t| !t.is_expired());
    }
}
