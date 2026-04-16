//! Font installation for the egui desktop (polish plan §6).
//!
//! Target: Geist Sans + Geist Mono as primary proportional/monospace faces.
//! Expected drop locations (relative to the crate root):
//!
//! - `desktop/assets/fonts/Geist-Regular.ttf`
//! - `desktop/assets/fonts/Geist-Medium.ttf`
//! - `desktop/assets/fonts/GeistMono-Regular.ttf`
//! - `desktop/assets/fonts/LICENSE.txt` (OFL — ship with binary)
//!
//! Font loading runs at startup. Each asset is attempted individually via
//! `std::fs::read`; missing files fall back to the egui defaults so the app
//! still runs without the OFL bundle. When the assets ship, swap this for
//! `include_bytes!` so the fonts end up in the single binary.

use std::path::PathBuf;

use eframe::egui::{self, FontData, FontDefinitions, FontFamily};

pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let asset_dir = asset_dir();

    if let Some(bytes) = load(&asset_dir, "Geist-Regular.ttf") {
        fonts.font_data.insert(
            "Geist".to_owned(),
            std::sync::Arc::new(FontData::from_owned(bytes)),
        );
        fonts
            .families
            .entry(FontFamily::Proportional)
            .or_default()
            .insert(0, "Geist".to_owned());
    }

    if let Some(bytes) = load(&asset_dir, "Geist-Medium.ttf") {
        fonts.font_data.insert(
            "Geist-Medium".to_owned(),
            std::sync::Arc::new(FontData::from_owned(bytes)),
        );
        fonts.families.insert(
            FontFamily::Name("GeistMedium".into()),
            vec!["Geist-Medium".to_owned()],
        );
    }

    if let Some(bytes) = load(&asset_dir, "GeistMono-Regular.ttf") {
        fonts.font_data.insert(
            "GeistMono".to_owned(),
            std::sync::Arc::new(FontData::from_owned(bytes)),
        );
        fonts
            .families
            .entry(FontFamily::Monospace)
            .or_default()
            .insert(0, "GeistMono".to_owned());
    }

    ctx.set_fonts(fonts);
}

fn asset_dir() -> PathBuf {
    // Dev path: <crate>/assets/fonts. Packaging step should drop the same
    // directory next to the binary; this check finds either.
    let here = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    if let Some(here) = here {
        let packaged = here.join("assets").join("fonts");
        if packaged.is_dir() {
            return packaged;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("fonts")
}

fn load(dir: &PathBuf, name: &str) -> Option<Vec<u8>> {
    let path = dir.join(name);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            log::debug!("font asset missing: {} (falling back to egui default)", path.display());
            None
        }
    }
}
