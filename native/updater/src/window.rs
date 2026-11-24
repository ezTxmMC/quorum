//! The update window: one floating island in Quorum's colours with the mark, a status line and a running bar.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use eframe::egui::{
    self, Color32, CornerRadius, FontId, Pos2, Rect, Sense, Shape, Stroke, StrokeKind, Vec2,
    ViewportCommand,
};

use crate::install::{Language, Phase};

const SIZE: Vec2 = Vec2::new(380.0, 132.0);
const ISLAND: Color32 = Color32::from_rgb(0x17, 0x1a, 0x21);
const TRACK: Color32 = Color32::from_rgb(0x25, 0x2a, 0x36);
const TEXT: Color32 = Color32::from_rgb(0xec, 0xef, 0xf4);
const MUTED: Color32 = Color32::from_rgb(0xa3, 0xad, 0xbf);
const ACCENT: Color32 = Color32::from_rgb(0x7c, 0x8c, 0xff);
const DANGER: Color32 = Color32::from_rgb(0xf8, 0x71, 0x71);

/// The Quorum mark on a 100×100 grid, same geometry as `shared/brand.ts`.
const MARK: [([[f32; 2]; 4], Color32); 3] = [
    (
        [[48.88, 9.05], [48.88, 36.3], [30.47, 69.78], [7.96, 83.45]],
        Color32::from_rgb(79, 123, 255),
    ),
    (
        [[51.12, 9.05], [92.04, 83.45], [69.53, 69.78], [51.12, 36.3]],
        Color32::from_rgb(138, 107, 255),
    ),
    (
        [
            [90.92, 85.48],
            [9.08, 85.48],
            [31.59, 71.81],
            [68.41, 71.81],
        ],
        Color32::from_rgb(201, 211, 255),
    ),
];
const MARK_CENTRE: [[f32; 2]; 3] = [[50.0, 47.5], [58.4, 63.5], [41.6, 63.5]];

pub fn show(phase: Arc<Mutex<Phase>>, language: Language) -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Quorum Update")
            .with_app_id("quorum-updater")
            .with_inner_size(SIZE)
            .with_resizable(false)
            .with_decorations(false)
            .with_transparent(true),
        centered: true,
        ..Default::default()
    };
    eframe::run_native(
        "Quorum Update",
        options,
        Box::new(move |_| Ok(Box::new(UpdateWindow { phase, language }))),
    )
}

struct UpdateWindow {
    phase: Arc<Mutex<Phase>>,
    language: Language,
}

impl eframe::App for UpdateWindow {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0; 4]
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let phase = self.phase.lock().unwrap().clone();
        if matches!(phase, Phase::Done | Phase::Cancelled) {
            ui.ctx().send_viewport_cmd(ViewportCommand::Close);
            return;
        }
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE)
            .show(ui, |ui| self.island(ui, &phase));
        ui.ctx().request_repaint_after(Duration::from_millis(16));
    }
}

impl UpdateWindow {
    fn island(&self, ui: &mut egui::Ui, phase: &Phase) {
        let area = ui.max_rect().shrink(1.0);
        let drag = ui.interact(area, ui.scope_id().with("drag"), Sense::click_and_drag());
        if drag.drag_started() {
            ui.ctx().send_viewport_cmd(ViewportCommand::StartDrag);
        }
        let painter = ui.painter();
        painter.rect(
            area,
            CornerRadius::same(16),
            ISLAND,
            Stroke::new(1.0, Color32::from_white_alpha(22)),
            StrokeKind::Inside,
        );
        paint_mark(
            painter,
            Rect::from_min_size(area.min + Vec2::new(22.0, 24.0), Vec2::splat(40.0)),
        );

        let left = area.min.x + 78.0;
        painter.text(
            Pos2::new(left, area.min.y + 26.0),
            egui::Align2::LEFT_TOP,
            self.title(phase),
            FontId::proportional(16.0),
            TEXT,
        );
        let failed = matches!(phase, Phase::Failed(_));
        painter.text(
            Pos2::new(left, area.min.y + 50.0),
            egui::Align2::LEFT_TOP,
            self.detail(phase),
            FontId::proportional(12.5),
            if failed { DANGER } else { MUTED },
        );
        if let Phase::Failed(_) = phase {
            self.restart_button(ui, area);
            return;
        }
        paint_bar(painter, area, ui.input(|input| input.time));
    }

    fn restart_button(&self, ui: &mut egui::Ui, area: Rect) {
        let label = match self.language {
            Language::German => "Quorum starten",
            Language::English => "Start Quorum",
        };
        let button = Rect::from_min_size(
            Pos2::new(area.max.x - 152.0, area.max.y - 44.0),
            Vec2::new(130.0, 28.0),
        );
        let response = ui.interact(button, ui.scope_id().with("restart"), Sense::click());
        let fill = if response.hovered() {
            ACCENT.gamma_multiply(0.85)
        } else {
            ACCENT
        };
        ui.painter()
            .rect_filled(button, CornerRadius::same(7), fill);
        ui.painter().text(
            button.center(),
            egui::Align2::CENTER_CENTER,
            label,
            FontId::proportional(12.5),
            Color32::from_rgb(0x0c, 0x0e, 0x14),
        );
        if response.clicked() {
            ui.ctx().send_viewport_cmd(ViewportCommand::Close);
        }
    }

    fn title(&self, phase: &Phase) -> &'static str {
        match (self.language, phase) {
            (Language::German, Phase::Failed(_)) => "Update fehlgeschlagen",
            (Language::English, Phase::Failed(_)) => "Update failed",
            (Language::German, _) => "Quorum wird aktualisiert",
            (Language::English, _) => "Updating Quorum",
        }
    }

    fn detail(&self, phase: &Phase) -> String {
        let german = self.language == Language::German;
        match phase {
            Phase::WaitingForExit if german => "Quorum wird beendet …".into(),
            Phase::WaitingForExit => "Closing Quorum …".into(),
            Phase::Installing if german => "Neue Version wird installiert …".into(),
            Phase::Installing => "Installing the new version …".into(),
            Phase::Failed(reason) if german => {
                format!("Die bisherige Version bleibt erhalten. ({reason})")
            }
            Phase::Failed(reason) => format!("The previous version is kept. ({reason})"),
            _ if german => "Wird eingerichtet, gleich startet Quorum neu …".into(),
            _ => "Finishing up, Quorum restarts in a moment …".into(),
        }
    }
}

fn paint_mark(painter: &egui::Painter, bounds: Rect) {
    let place =
        |point: &[f32; 2]| bounds.min + Vec2::new(point[0], point[1]) * (bounds.width() / 100.0);
    for (points, colour) in &MARK {
        painter.add(Shape::convex_polygon(
            points.iter().map(place).collect(),
            *colour,
            Stroke::NONE,
        ));
    }
    painter.add(Shape::convex_polygon(
        MARK_CENTRE.iter().map(place).collect(),
        TEXT,
        Stroke::NONE,
    ));
}

/// Indeterminate bar: the steps have no measurable progress, so a light sweeps across instead of a percentage.
fn paint_bar(painter: &egui::Painter, area: Rect, time: f64) {
    let track = Rect::from_min_max(
        Pos2::new(area.min.x + 22.0, area.max.y - 30.0),
        Pos2::new(area.max.x - 22.0, area.max.y - 26.0),
    );
    painter.rect_filled(track, CornerRadius::same(2), TRACK);
    let cycle = (time / 1.6).fract() as f32;
    let eased = cycle * cycle * (3.0 - 2.0 * cycle);
    let width = track.width() * 0.34;
    let start = track.min.x - width + (track.width() + width) * eased;
    let glow = Rect::from_min_max(
        Pos2::new(start.max(track.min.x), track.min.y),
        Pos2::new((start + width).min(track.max.x), track.max.y),
    );
    if glow.width() > 0.0 {
        painter.rect_filled(glow, CornerRadius::same(2), ACCENT);
    }
}
