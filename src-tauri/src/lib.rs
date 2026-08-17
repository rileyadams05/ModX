use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
#[cfg(not(target_os = "windows"))]
use sysinfo::System;
use tauri::{Emitter, Manager};

mod game_library;
#[cfg(target_os = "windows")]
mod windows_applications;
#[cfg(target_os = "windows")]
mod windows_icon;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunningProcess {
    pid: u32,
    name: String,
    display_name: String,
    executable: Option<String>,
    icon_data_url: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedTarget {
    process_name: String,
    executable: Option<String>,
}

#[derive(Default)]
struct ProcessListState {
    service_id: Mutex<Option<String>>,
}

#[tauri::command]
fn open_process_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcessListState>,
    service_id: String,
) -> Result<(), String> {
    *state.service_id.lock().map_err(|error| error.to_string())? = Some(service_id);

    if let Some(window) = app.get_webview_window("process-list") {
        window.show().map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        window
            .emit("process-list-opened", ())
            .map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "process-list",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Process List")
    .inner_size(370.0, 470.0)
    .min_inner_size(340.0, 430.0)
    .resizable(true)
    .always_on_top(true)
    .center()
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_process_list_service_id(
    state: tauri::State<'_, ProcessListState>,
) -> Result<String, String> {
    state
        .service_id
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "No service selected for Add Game".to_string())
}

#[tauri::command]
fn close_process_list(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("process-list")
        .ok_or_else(|| "Process List window is unavailable".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

fn target_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("target-process.json"))
}

fn read_target_file(file: &std::path::Path) -> Result<Option<SavedTarget>, String> {
    if !file.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(file).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn write_target_file(file: &std::path::Path, target: &SavedTarget) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(target).map_err(|error| error.to_string())?;
    fs::write(file, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    window.set_title("ModX").map_err(|error| error.to_string())
}

#[tauri::command]
async fn scan_game_library(
    app: tauri::AppHandle,
    service_id: Option<String>,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::reconcile_library(&app, service_id.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result)
}

#[tauri::command]
async fn add_game_service(
    app: tauri::AppHandle,
    name: String,
    main_library_path: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::add_service(&app, name, main_library_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn remove_game_service(
    app: tauri::AppHandle,
    service_id: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || game_library::remove_service(&app, &service_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn learn_process_game(
    app: tauri::AppHandle,
    service_id: String,
    pid: u32,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::learn_process_game(&app, &service_id, pid).map(|(services, _)| services)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_custom_game_icon(
    app: tauri::AppHandle,
    game_id: String,
    source_path: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::set_custom_game_icon(&app, &game_id, &source_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reset_game_icon(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || game_library::reset_game_icon(&app, &game_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_custom_service_icon(
    app: tauri::AppHandle,
    service_id: String,
    source_path: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::set_custom_service_icon(&app, &service_id, &source_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reset_service_icon(
    app: tauri::AppHandle,
    service_id: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::reset_service_icon(&app, &service_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn resolve_online_game_icon(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::resolve_online_game_icon(&app, &game_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn retry_game_icon(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || game_library::retry_game_icon(&app, &game_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_steam_grid_db_icon_override(
    app: tauri::AppHandle,
    game_id: String,
    icon_id: u64,
) -> Result<Vec<game_library::GameService>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        game_library::set_steam_grid_db_icon_override(&app, &game_id, icon_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn launch_game(app: tauri::AppHandle, game_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || game_library::launch_game(&app, &game_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn list_running_processes(app: tauri::AppHandle) -> Vec<RunningProcess> {
    #[cfg(target_os = "windows")]
    {
        let icon_cache = app
            .path()
            .app_cache_dir()
            .ok()
            .map(|directory| directory.join("process-icons-v2"));
        return windows_applications::list_open_applications(
            std::process::id(),
            icon_cache.as_deref(),
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut system = System::new_all();
        system.refresh_all();
        let own_pid = std::process::id();
        let mut processes: Vec<_> = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                let pid = pid.as_u32();
                let name = process.name().to_string_lossy().trim().to_string();
                if pid == own_pid || name.is_empty() || pid <= 4 {
                    return None;
                }
                Some(RunningProcess {
                    pid,
                    display_name: name.trim_end_matches(".exe").to_string(),
                    name,
                    executable: process.exe().map(|path| path.to_string_lossy().to_string()),
                    icon_data_url: None,
                })
            })
            .collect();
        processes.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
                .then(a.pid.cmp(&b.pid))
        });
        processes
    }
}

#[tauri::command]
fn get_saved_target(app: tauri::AppHandle) -> Result<Option<SavedTarget>, String> {
    read_target_file(&target_file(&app)?)
}

#[tauri::command]
fn save_target(app: tauri::AppHandle, target: SavedTarget) -> Result<(), String> {
    write_target_file(&target_file(&app)?, &target)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcessListState::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(process_list) = window.app_handle().get_webview_window("process-list") {
                    let _ = process_list.destroy();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            add_game_service,
            close_process_list,
            frontend_ready,
            get_process_list_service_id,
            get_saved_target,
            launch_game,
            learn_process_game,
            list_running_processes,
            open_process_list,
            remove_game_service,
            reset_game_icon,
            reset_service_icon,
            resolve_online_game_icon,
            retry_game_icon,
            scan_game_library,
            save_target,
            set_custom_game_icon,
            set_custom_service_icon,
            set_steam_grid_db_icon_override,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ModX");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_target_round_trips_without_a_pid() {
        let file =
            std::env::temp_dir().join(format!("modx-target-test-{}.json", std::process::id()));
        let expected = SavedTarget {
            process_name: "ExampleGame.exe".into(),
            executable: Some(r"D:\Games\ExampleGame.exe".into()),
        };
        write_target_file(&file, &expected).unwrap();
        let loaded = read_target_file(&file).unwrap().unwrap();
        assert_eq!(loaded.process_name, expected.process_name);
        assert_eq!(loaded.executable, expected.executable);
        let json = fs::read_to_string(&file).unwrap();
        assert!(!json.to_ascii_lowercase().contains("pid"));
        fs::remove_file(file).unwrap();
    }
}
