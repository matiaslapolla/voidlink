//! Anchored toast host — paints a vertical stack of toasts in the bottom-right
//! corner, above all other panels. Reads from `ToastQueue`.
//!
//! Animations (plan §6):
//! - `toast_enter` — 180 ms ease_out_expo x-offset + opacity.
//! - `toast_exit`  — 140 ms linear as `ttl` approaches zero.

use eframe::egui::{self, Color32, CornerRadius, Frame, Margin, RichText, Stroke};

use crate::motion;
use crate::state::{Toast, ToastQueue, ToastVariant};
use crate::theme::ThemePalette;

pub fn toast_host(
    ctx: &egui::Context,
    palette: &ThemePalette,
    queue: &mut ToastQueue,
) {
    queue.prune();
    if queue.toasts.is_empty() {
        return;
    }

    // Collect dismiss requests during rendering; apply after.
    let mut dismiss: Vec<u64> = Vec::new();

    // Request repaint while toasts are on screen so ttl animates.
    ctx.request_repaint_after(std::time::Duration::from_millis(33));

    let anchor_offset = egui::vec2(-16.0, -16.0);
    egui::Area::new(egui::Id::new("voidlink_toast_host"))
        .anchor(egui::Align2::RIGHT_BOTTOM, anchor_offset)
        .order(egui::Order::Foreground)
        .interactable(true)
        .show(ctx, |ui| {
            ui.spacing_mut().item_spacing.y = 8.0;
            // Render newest on top visually (push_reverse)
            let toasts: Vec<Toast> = queue.toasts.iter().rev().cloned().collect();
            for toast in &toasts {
                if let Some(id) = render_toast(ui, palette, toast) {
                    dismiss.push(id);
                }
            }
        });

    for id in dismiss {
        queue.dismiss(id);
    }
}

fn render_toast(
    ui: &mut egui::Ui,
    palette: &ThemePalette,
    toast: &Toast,
) -> Option<u64> {
    let stripe_color = match toast.variant {
        ToastVariant::Info => palette.toast_info_stripe,
        ToastVariant::Success => palette.toast_success_stripe,
        ToastVariant::Warning => palette.toast_warning_stripe,
        ToastVariant::Error => palette.toast_error_stripe,
    };

    // Enter animation: first 180 ms of lifetime, x slides from +24 → 0, alpha 0 → 1.
    let age = toast.age().as_secs_f32();
    let enter_t = motion::ease_out_expo((age / motion::dur::TOAST_IN).clamp(0.0, 1.0));

    // Exit animation: final 140 ms before expiry.
    let remaining = toast.ttl.as_secs_f32() - age;
    let exit_t = if remaining < motion::dur::TOAST_OUT {
        (remaining / motion::dur::TOAST_OUT).clamp(0.0, 1.0)
    } else {
        1.0
    };

    let opacity_scale = enter_t * exit_t;
    let tint = |c: Color32, scale: f32| -> Color32 {
        Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), (c.a() as f32 * scale) as u8)
    };

    // Animate x-offset by wrapping the content in a sized allocation with a
    // translated painter; simplest reliable path is to shift via extra spacing
    // on the left margin of the outer frame.
    let slide_offset = (1.0 - enter_t) * 24.0;

    let frame = Frame {
        fill: tint(palette.rail_card_bg, opacity_scale.max(0.01)),
        stroke: Stroke::new(1.0, tint(palette.rail_card_border, opacity_scale)),
        corner_radius: CornerRadius::same(8),
        inner_margin: Margin::symmetric(14, 10),
        outer_margin: Margin {
            left: slide_offset as i8,
            right: 0,
            top: 0,
            bottom: 0,
        },
        shadow: egui::epaint::Shadow {
            offset: [0, 6],
            blur: 18,
            spread: 0,
            color: Color32::from_black_alpha(80),
        },
    };

    let mut dismissed: Option<u64> = None;

    frame.show(ui, |ui| {
        ui.set_max_width(340.0);
        ui.horizontal(|ui| {
            // Left stripe: 3 px colour bar.
            let (stripe_rect, _) = ui.allocate_exact_size(
                egui::vec2(3.0, 32.0),
                egui::Sense::hover(),
            );
            ui.painter().rect_filled(
                stripe_rect,
                CornerRadius::same(2),
                tint(stripe_color, opacity_scale),
            );

            ui.add_space(8.0);

            // Icon.
            ui.add(egui::Label::new(
                RichText::new(toast.variant.icon())
                    .size(16.0)
                    .color(tint(stripe_color, opacity_scale)),
            ));

            ui.add_space(6.0);

            // Title + body stack.
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.add(egui::Label::new(
                    RichText::new(&toast.title)
                        .strong()
                        .size(13.0)
                        .color(tint(palette.text, opacity_scale)),
                ));
                if let Some(body) = &toast.body {
                    ui.add(egui::Label::new(
                        RichText::new(body)
                            .size(12.0)
                            .color(tint(palette.text_muted, opacity_scale)),
                    ));
                }
            });

            ui.add_space(10.0);

            // Close affordance — small × on the right.
            if ui
                .small_button(
                    RichText::new("\u{2715}")
                        .size(11.0)
                        .color(tint(palette.text_muted, opacity_scale)),
                )
                .clicked()
            {
                dismissed = Some(toast.id);
            }
        });
    });

    dismissed
}
