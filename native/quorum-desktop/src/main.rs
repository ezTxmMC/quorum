mod editor;
mod ide;
mod input;
mod plans;
mod theme;
mod workbench;

use gpui::{App, Application, Bounds, WindowBounds, WindowOptions, prelude::*, px, size};
use quorum_core::archive;
use workbench::Workbench;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--worker") {
        if let Err(error) = quorum_core::worker::run() {
            let _ = quorum_core::worker::emit(
                serde_json::json!({"type":"done","ok":false,"error":error.to_string()}),
            );
            std::process::exit(1);
        }
        return;
    }
    let root = match archive::data_directory() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("Quorum: {error}");
            std::process::exit(1);
        }
    };
    Application::new()
        .with_assets(theme::Assets)
        .run(move |cx: &mut App| {
            input::init(cx);
            editor::init(cx);
            workbench::init(cx);
            let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
            let result = cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                move |window, cx| {
                    let view = cx.new(|cx| Workbench::new(root, cx));
                    let weak = view.downgrade();
                    window.on_window_should_close(cx, move |window, cx| {
                        weak.update(cx, |view, cx| view.should_close(window, cx))
                            .unwrap_or(true)
                    });
                    view
                },
            );
            if let Err(error) = result {
                eprintln!("Quorum window: {error}");
                cx.quit();
                return;
            }
            cx.activate(true);
        });
}
