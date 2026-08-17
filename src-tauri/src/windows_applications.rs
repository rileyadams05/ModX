#![cfg(target_os = "windows")]

use crate::RunningProcess;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{
    collections::HashMap,
    ffi::c_void,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    path::Path,
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};
use sysinfo::{Pid, System};
use windows_sys::{
    Win32::{
        Foundation::{HWND, LPARAM},
        Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
            IsWindowVisible,
        },
    },
    core::BOOL,
};

#[derive(Debug)]
struct WindowCandidate {
    pid: u32,
    title: String,
}

static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

pub fn list_open_applications(own_pid: u32, icon_cache: Option<&Path>) -> Vec<RunningProcess> {
    let windows = enumerate_visible_windows();
    let mut system = System::new_all();
    system.refresh_all();
    let mut applications: HashMap<String, RunningProcess> = HashMap::new();

    for window in windows {
        if window.pid == own_pid || window.pid <= 4 {
            continue;
        }
        let Some(process) = system.process(Pid::from_u32(window.pid)) else {
            continue;
        };
        let name = process.name().to_string_lossy().trim().to_string();
        let Some(executable) = process.exe().map(Path::to_path_buf) else {
            continue;
        };
        if name.is_empty() || is_excluded_application(&name, &window.title, &executable) {
            continue;
        }

        let identity = normalize_path(&executable);
        let candidate = RunningProcess {
            pid: window.pid,
            display_name: friendly_application_name(&window.title, &executable),
            name,
            executable: Some(executable.to_string_lossy().to_string()),
            icon_data_url: cached_icon(&executable, icon_cache),
        };
        applications
            .entry(identity)
            .and_modify(|existing| {
                if candidate.display_name.len() < existing.display_name.len() {
                    *existing = candidate.clone();
                }
            })
            .or_insert(candidate);
    }

    let mut applications: Vec<_> = applications.into_values().collect();
    applications.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then(
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase()),
            )
    });
    applications
}

fn enumerate_visible_windows() -> Vec<WindowCandidate> {
    let mut windows = Vec::<WindowCandidate>::new();
    unsafe {
        let _ = EnumWindows(Some(collect_window), &mut windows as *mut _ as LPARAM);
    }
    windows
}

unsafe extern "system" fn collect_window(hwnd: HWND, state: LPARAM) -> BOOL {
    if unsafe { IsWindowVisible(hwnd) } == 0 || is_cloaked(hwnd) {
        return 1;
    }
    let title_length = unsafe { GetWindowTextLengthW(hwnd) };
    if title_length <= 0 {
        return 1;
    }
    let mut title = vec![0u16; title_length as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) };
    if copied <= 0 {
        return 1;
    }
    let title = String::from_utf16_lossy(&title[..copied as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return 1;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid != 0 {
        let windows = unsafe { &mut *(state as *mut Vec<WindowCandidate>) };
        windows.push(WindowCandidate { pid, title });
    }
    1
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut _ as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    result >= 0 && cloaked != 0
}

fn is_excluded_application(name: &str, title: &str, executable: &Path) -> bool {
    let name = name.to_ascii_lowercase();
    let title = title.to_ascii_lowercase();
    let path = executable.to_string_lossy().to_ascii_lowercase();
    const EXACT: &[&str] = &[
        "applicationframehost.exe",
        "explorer.exe",
        "searchhost.exe",
        "searchapp.exe",
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "systemsettings.exe",
        "textinputhost.exe",
        "lockapp.exe",
        "dwm.exe",
        "taskhostw.exe",
        "runtimebroker.exe",
        "sihost.exe",
        "ctfmon.exe",
        "widgets.exe",
        "widgetservice.exe",
        "securityhealthsystray.exe",
        "steam.exe",
        "epicgameslauncher.exe",
        "upc.exe",
        "ubisoftconnect.exe",
        "eadesktop.exe",
        "battle.net.exe",
        "goggalaxy.exe",
    ];
    if EXACT.contains(&name.as_str()) {
        return true;
    }
    const HELPER_TERMS: &[&str] = &[
        "anticheat",
        "anti-cheat",
        "battleye",
        "crash",
        "reporter",
        "updater",
        "update.exe",
        "uninstall",
        "unins",
        "installer",
        "setup.exe",
        "overlay",
        "cefsubprocess",
        "webhelper",
        "bootstrapper",
        "launcher.exe",
        "launcher64.exe",
    ];
    HELPER_TERMS
        .iter()
        .any(|term| name.contains(term) || title.contains(term) || path.contains(term))
}

fn friendly_application_name(title: &str, executable: &Path) -> String {
    let title = title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    executable
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Open application")
        .replace(['_', '-'], " ")
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn cached_icon(executable: &Path, cache_directory: Option<&Path>) -> Option<String> {
    let key = icon_cache_key(executable);
    let cache = ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock()
        && let Some(icon) = guard.get(&key)
    {
        return icon.clone();
    }
    let icon = cache_directory
        .and_then(|directory| read_cached_master(directory, &key))
        .or_else(|| {
            let (bytes, width, height) = crate::windows_icon::extract_png(executable, 256).ok()?;
            if width == 0 || height == 0 || image::load_from_memory(&bytes).is_err() {
                return None;
            }
            if let Some(directory) = cache_directory {
                let _ = write_cached_master(directory, &key, &bytes);
            }
            Some(png_data_url(&bytes))
        });
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, icon.clone());
    }
    icon
}

fn icon_cache_key(executable: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    normalize_path(executable).hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(executable) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified()
            && let Ok(elapsed) = modified.duration_since(UNIX_EPOCH)
        {
            elapsed.as_secs().hash(&mut hasher);
            elapsed.subsec_nanos().hash(&mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn read_cached_master(directory: &Path, key: &str) -> Option<String> {
    let bytes = fs::read(directory.join(format!("{key}.png"))).ok()?;
    let image = image::load_from_memory(&bytes).ok()?;
    if image.width() == 0 || image.height() == 0 {
        return None;
    }
    Some(png_data_url(&bytes))
}

fn write_cached_master(directory: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let destination = directory.join(format!("{key}.png"));
    fs::write(&destination, bytes).map_err(|error| error.to_string())?;
    let written = fs::read(&destination).map_err(|error| error.to_string())?;
    image::load_from_memory(&written).map_err(|error| error.to_string())?;
    Ok(())
}

fn png_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_launchers_and_system_windows_are_excluded() {
        assert!(is_excluded_application(
            "ApplicationFrameHost.exe",
            "Settings",
            Path::new(r"C:\Windows\System32\ApplicationFrameHost.exe"),
        ));
        assert!(is_excluded_application(
            "GameCrashReporter.exe",
            "Game Crash Reporter",
            Path::new(r"D:\Games\Example\GameCrashReporter.exe"),
        ));
        assert!(is_excluded_application(
            "EpicGamesLauncher.exe",
            "Epic Games Launcher",
            Path::new(r"C:\Program Files\Epic Games\Launcher\EpicGamesLauncher.exe"),
        ));
    }

    #[test]
    fn normal_game_windows_are_kept() {
        assert!(!is_excluded_application(
            "AC4BFSP.exe",
            "Assassin's Creed IV Black Flag",
            Path::new(r"D:\Games\Black Flag\AC4BFSP.exe"),
        ));
    }
}
