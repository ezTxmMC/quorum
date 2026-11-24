#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use quorum_core::{archive::data_directory, desktop_profile::DesktopProfile, service::Service};
use rfd::{AsyncFileDialog, AsyncMessageDialog, MessageButtons, MessageDialogResult};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::{path::PathBuf, process::Command, sync::Arc};
use tauri::{
    Emitter, Manager, State, WebviewWindow,
    ipc::{InvokeBody, Request, Response},
};

async fn call(service: Arc<Service>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || service.call(&channel, &args))
        .await
        .map_err(|error| error.to_string())?
}

fn spawn_os_opener(target: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(target);
        cmd
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(target);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", target]);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn open_external_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Nur http:// und https:// Links sind erlaubt.".into());
    }
    spawn_os_opener(url)
}

fn reveal_path(target: &str) -> Result<(), String> {
    let path = PathBuf::from(target);
    let directory = if path.is_dir() {
        path
    } else {
        path.parent().map(PathBuf::from).unwrap_or(path)
    };
    let text = directory
        .to_str()
        .ok_or_else(|| "Pfad enthält ungültige Zeichen.".to_string())?;
    spawn_os_opener(text)
}

async fn save_image_as(source: &str) -> Result<bool, String> {
    let source_path = PathBuf::from(source);
    let mut dialog = AsyncFileDialog::new();
    if let Some(name) = source_path.file_name().and_then(|value| value.to_str()) {
        dialog = dialog.set_file_name(name);
    }
    let Some(destination) = dialog.save_file().await else {
        return Ok(false);
    };
    let target_path = destination.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || std::fs::copy(source_path, target_path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn load_profile(
    service: State<'_, Arc<Service>>,
    profile: State<'_, Arc<Mutex<DesktopProfile>>>,
) -> Result<Response, String> {
    let service = Arc::clone(service.inner());
    let store = Arc::clone(profile.inner());
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let db = store.lock().map_err(|error| error.to_string())?;
        if let Some(raw) = db.load_raw().map_err(|error| error.to_string())? {
            return Ok(raw.into_bytes());
        }
        let legacy = service.call("store:seed", &[])?;
        let serialized = serde_json::to_string(&legacy).map_err(|error| error.to_string())?;
        db.save_raw(&serialized)
            .map_err(|error| error.to_string())?;
        Ok(serialized.into_bytes())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn save_profile(
    request: Request<'_>,
    profile: State<'_, Arc<Mutex<DesktopProfile>>>,
) -> Result<(), String> {
    let raw = match request.body() {
        InvokeBody::Raw(bytes) => {
            String::from_utf8(bytes.clone()).map_err(|error| error.to_string())?
        }
        InvokeBody::Json(value) => {
            serde_json::to_string(value).map_err(|error| error.to_string())?
        }
    };
    let store = Arc::clone(profile.inner());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let db = store.lock().map_err(|error| error.to_string())?;
        db.save_raw(&raw).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dispatch(
    window: WebviewWindow,
    service: State<'_, Arc<Service>>,
    profile: State<'_, Arc<Mutex<DesktopProfile>>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let service = Arc::clone(service.inner());
    match channel.as_str() {
        "store:load" | "store:save" => {
            let store = Arc::clone(profile.inner());
            let loading = channel == "store:load";
            tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
                let db = store.lock().map_err(|e| e.to_string())?;
                if loading {
                    let value = match db.load().map_err(|e| e.to_string())? {
                        Some(value) => value,
                        None => {
                            let legacy = service.call("store:seed", &[])?;
                            db.save(&legacy).map_err(|e| e.to_string())?;
                            legacy
                        }
                    };
                    service.call("store:adopt", std::slice::from_ref(&value))?;
                    return Ok(value);
                }
                let value = args.first().ok_or("Profil fehlt")?;
                db.save(value).map_err(|e| e.to_string())?;
                service.call("store:ack", &args)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        "shell:open" => {
            let target = args.first().and_then(Value::as_str).ok_or("Pfad fehlt")?;
            spawn_os_opener(target)?;
            Ok(json!(""))
        }
        "shell:reveal" => {
            let target = args.first().and_then(Value::as_str).ok_or("Pfad fehlt")?;
            reveal_path(target)?;
            Ok(Value::Null)
        }
        "shell:external" => {
            let url = args.first().and_then(Value::as_str).ok_or("URL fehlt")?;
            open_external_url(url)?;
            Ok(Value::Null)
        }
        "image:saveAs" => {
            let source = args
                .first()
                .and_then(Value::as_str)
                .ok_or("Bildpfad fehlt")?;
            Ok(json!(save_image_as(source).await?))
        }
        "dialog:folder" => {
            let folder = AsyncFileDialog::new().pick_folder().await;
            Ok(json!(folder.map(|file| file.path().to_path_buf())))
        }
        "dialog:files" => {
            let dialog = AsyncFileDialog::new();
            let dialog = match args.first().and_then(Value::as_str) {
                Some("image") => {
                    dialog.add_filter("Bilder", &["png", "jpg", "jpeg", "gif", "webp"])
                }
                Some("json") => dialog.add_filter("JSON", &["json"]),
                _ => dialog,
            };
            Ok(json!(
                dialog
                    .pick_files()
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|file| file.path())
                    .collect::<Vec<_>>()
            ))
        }
        "lsp:start" => {
            let root = args
                .first()
                .and_then(Value::as_str)
                .ok_or("Workspace fehlt")?;
            let answer = AsyncMessageDialog::new()
                .set_title("Language Server starten")
                .set_description(format!(
                    "Diesem Workspace für die lokale Codeanalyse vertrauen?\n{root}"
                ))
                .set_buttons(MessageButtons::YesNo)
                .show()
                .await;
            if answer != MessageDialogResult::Yes {
                return Ok(json!({"state":"stopped","root":root,"language":args.get(1)}));
            }
            call(service, channel, args).await
        }
        "chat:close-window" => {
            let active = call(service.clone(), "chat:prepare".into(), vec![]).await?;
            if active.as_u64().unwrap_or_default() > 0 {
                let result = AsyncMessageDialog::new().set_title("Laufende Chats")
                    .set_description("Chats im Hintergrund weiterlaufen lassen? Bei Nein werden alle Chat-Prozesse gestoppt.")
                    .set_buttons(MessageButtons::YesNoCancel).show().await;
                if result == MessageDialogResult::Cancel {
                    return call(service, "chat:resume-starts".into(), vec![]).await;
                }
                if result == MessageDialogResult::No {
                    call(service.clone(), "chat:stop-all".into(), vec![]).await?;
                }
            }
            window.destroy().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => call(service, channel, args).await,
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let assets = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
            } else {
                app.path().resource_dir()?
            };
            app.manage(Arc::new(Mutex::new(DesktopProfile::open(
                &data_directory()?,
            )?)));
            let mut command = Command::new("node");
            command
                .arg(assets.join("dist-service/quorum-service.mjs"))
                .arg(&assets)
                .current_dir(&assets);
            let handle = app.handle().clone();
            app.manage(Arc::new(Service::spawn(&mut command, move |event| {
                let _ = handle.emit("quorum-event", event);
            })?));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            load_profile,
            save_profile
        ])
        .run(tauri::generate_context!())
        .expect("Quorum konnte nicht starten");
}
