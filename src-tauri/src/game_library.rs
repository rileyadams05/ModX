use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, hash_map::DefaultHasher},
    env, fs,
    hash::{Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::Manager;

// v5 preserves native pixels and excludes installer/helper executables from
// service-icon sources.
const ICON_CACHE_VERSION: u32 = 5;
const HIGH_QUALITY_ICON_EDGE: u32 = 128;
const MASTER_ICON_EDGE: u32 = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameServiceConfig {
    pub id: String,
    pub name: String,
    pub main_library_path: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub saved_games: Vec<SavedGame>,
    #[serde(default)]
    cached_library_games: Vec<CachedLibraryGame>,
    #[serde(default)]
    custom_icon_path: Option<String>,
    #[serde(default)]
    automatic_icon_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedLibraryGame {
    display_name: String,
    install_path: String,
    executable_path: Option<String>,
    #[serde(default)]
    custom_icon_path: Option<String>,
    #[serde(default)]
    online_icon_path: Option<String>,
    #[serde(default)]
    steam_grid_db_icon_id: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedGame {
    pub id: String,
    pub display_name: String,
    pub install_path: String,
    pub executable_path: String,
    pub executable_name: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub custom_icon_path: Option<String>,
    #[serde(default)]
    pub online_icon_path: Option<String>,
    #[serde(default)]
    pub steam_grid_db_icon_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGame {
    pub id: String,
    pub service_id: String,
    pub display_name: String,
    pub install_path: String,
    pub executable_path: Option<String>,
    pub executable_name: Option<String>,
    pub discovery_source: DiscoverySource,
    pub is_available: bool,
    pub icon_data_url: Option<String>,
    pub has_custom_icon: bool,
    pub needs_icon_upgrade: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoverySource {
    MainLibrary,
    SavedProcess,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameService {
    pub id: String,
    pub name: String,
    pub main_library_path: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub path_available: bool,
    pub games: Vec<LibraryGame>,
    pub scan_error: Option<String>,
    pub icon_data_url: Option<String>,
    pub has_custom_icon: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryConfig {
    #[serde(default)]
    services: Vec<GameServiceConfig>,
}

pub fn load_library(app: &tauri::AppHandle) -> Result<Vec<GameService>, String> {
    reconcile_library(app, None)
}

pub fn reconcile_library(
    app: &tauri::AppHandle,
    service_id: Option<&str>,
) -> Result<Vec<GameService>, String> {
    let mut config = read_config(app)?;
    let mut changed = false;
    let icon_cache = icon_cache_directory(app)?;
    for service in &mut config.services {
        if service_id.is_some_and(|id| id != service.id) {
            continue;
        }
        if let Some(mut snapshot) = scan_library_root(service)
            && {
                for game in &mut snapshot {
                    if let Some(previous) = service.cached_library_games.iter().find(|previous| {
                        normalize_path(Path::new(&previous.install_path))
                            == normalize_path(Path::new(&game.install_path))
                    }) {
                        game.custom_icon_path.clone_from(&previous.custom_icon_path);
                        game.online_icon_path.clone_from(&previous.online_icon_path);
                        game.steam_grid_db_icon_id = previous.steam_grid_db_icon_id;
                    }
                }
                snapshot != service.cached_library_games
            }
        {
            service.cached_library_games = snapshot;
            service.updated_at = now();
            changed = true;
        }
        if service_id.is_none()
            && service.custom_icon_path.is_none()
            && service.automatic_icon_path.as_deref().is_some_and(|path| {
                let path = Path::new(path);
                !is_high_quality_image(path) || !is_current_icon_cache_path(path)
            })
        {
            eprintln!(
                "[IconResolver] service={} invalidating legacy_or_low_resolution_cache path={}",
                service.name,
                service.automatic_icon_path.as_deref().unwrap_or_default()
            );
            service.automatic_icon_path = None;
            changed = true;
        }
        if service_id.is_none()
            && service.custom_icon_path.is_none()
            && service.automatic_icon_path.is_none()
        {
            service.automatic_icon_path = find_service_executable(service)
                .and_then(|path| {
                    eprintln!(
                        "[IconResolver] service={} detected_executable={} requested_master=256x256 rendered_sidebar=25x25 rendered_header=76x76",
                        service.name,
                        path.display()
                    );
                    cached_executable_icon_path(&path, &icon_cache)
                })
                .map(|path| path.to_string_lossy().to_string());
            if service.automatic_icon_path.is_some() {
                changed = true;
            } else {
                eprintln!(
                    "Launcher application not found for configured service: {}",
                    service.name
                );
            }
        }
    }
    if changed {
        write_config(app, &config)?;
    }
    Ok(config
        .services
        .iter()
        .map(|service| build_service(service, &icon_cache))
        .collect())
}

pub fn add_service(
    app: &tauri::AppHandle,
    name: String,
    main_library_path: String,
) -> Result<Vec<GameService>, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err("Enter a service name up to 80 characters.".into());
    }
    let path = canonical_existing_directory(&main_library_path)?;
    let normalized = normalize_path(&path);
    let mut config = read_config(app)?;
    if config
        .services
        .iter()
        .any(|service| normalize_path(Path::new(&service.main_library_path)) == normalized)
    {
        return Err("That library location is already assigned to a service.".into());
    }
    let now = now();
    config.services.push(GameServiceConfig {
        id: format!(
            "service-{}",
            stable_hash(&format!("{name}:{normalized}:{now}"))
        ),
        name: name.to_string(),
        main_library_path: path.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
        saved_games: Vec::new(),
        cached_library_games: Vec::new(),
        custom_icon_path: None,
        automatic_icon_path: None,
    });
    write_config(app, &config)?;
    reconcile_library(app, None)
}

pub fn remove_service(
    app: &tauri::AppHandle,
    service_id: &str,
) -> Result<Vec<GameService>, String> {
    let mut config = read_config(app)?;
    let before = config.services.len();
    config.services.retain(|service| service.id != service_id);
    if config.services.len() == before {
        return Err("Service not found.".into());
    }
    write_config(app, &config)?;
    reconcile_library(app, None)
}

pub fn learn_process_game(
    app: &tauri::AppHandle,
    service_id: &str,
    pid: u32,
) -> Result<(Vec<GameService>, SavedGame), String> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or("That process is no longer running.")?;
    let executable = process
        .exe()
        .ok_or("Windows did not allow ModX to read that process location.")?;
    let executable = canonical_existing_file(executable)?;
    let install = executable
        .parent()
        .ok_or("The game install location could not be determined.")?
        .to_path_buf();
    let executable_name = executable
        .file_name()
        .ok_or("The process executable has no filename.")?
        .to_string_lossy()
        .to_string();
    let display_name = executable
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(['_', '-'], " ")
        .trim()
        .to_string();
    let normalized_executable = normalize_path(&executable);
    let now = now();
    let mut config = read_config(app)?;
    let service = config
        .services
        .iter_mut()
        .find(|service| service.id == service_id)
        .ok_or("Choose an existing service.")?;
    let saved = if let Some(existing) = service
        .saved_games
        .iter_mut()
        .find(|game| normalize_path(Path::new(&game.executable_path)) == normalized_executable)
    {
        existing.display_name = display_name;
        existing.install_path = install.to_string_lossy().to_string();
        existing.executable_path = executable.to_string_lossy().to_string();
        existing.executable_name = executable_name;
        existing.updated_at = now;
        existing.clone()
    } else {
        let game = SavedGame {
            id: format!(
                "saved-{}",
                stable_hash(&format!("{service_id}:{normalized_executable}"))
            ),
            display_name,
            install_path: install.to_string_lossy().to_string(),
            executable_path: executable.to_string_lossy().to_string(),
            executable_name,
            created_at: now,
            updated_at: now,
            custom_icon_path: None,
            online_icon_path: None,
            steam_grid_db_icon_id: None,
        };
        service.saved_games.push(game.clone());
        game
    };
    service.updated_at = now;
    write_config(app, &config)?;
    Ok((reconcile_library(app, None)?, saved))
}

pub fn launch_game(app: &tauri::AppHandle, game_id: &str) -> Result<(), String> {
    let game = load_library(app)?
        .into_iter()
        .flat_map(|service| service.games)
        .find(|game| game.id == game_id)
        .ok_or("Game not found.")?;
    let executable = game
        .executable_path
        .ok_or("ModX could not identify a launchable game executable.")?;
    let executable = canonical_existing_file(Path::new(&executable))?;
    let mut command = Command::new(&executable);
    if let Some(directory) = executable.parent() {
        command.current_dir(directory);
    }
    command
        .spawn()
        .map_err(|error| format!("The game could not be launched: {error}"))?;
    Ok(())
}

pub fn set_custom_game_icon(
    app: &tauri::AppHandle,
    game_id: &str,
    source: &str,
) -> Result<Vec<GameService>, String> {
    let saved_path = save_custom_icon(app, source, &format!("game-{game_id}"))?;
    let mut config = read_config(app)?;
    let mut found = false;
    for service in &mut config.services {
        for game in &mut service.cached_library_games {
            if cached_game_id(service.id.as_str(), game) == game_id {
                game.custom_icon_path = Some(saved_path.clone());
                found = true;
            }
        }
        for game in &mut service.saved_games {
            if saved_game_id(service.id.as_str(), game) == game_id {
                game.custom_icon_path = Some(saved_path.clone());
                found = true;
            }
        }
    }
    if !found {
        return Err("Game not found.".into());
    }
    write_config(app, &config)?;
    reconcile_library(app, None)
}

pub fn reset_game_icon(app: &tauri::AppHandle, game_id: &str) -> Result<Vec<GameService>, String> {
    let mut config = read_config(app)?;
    let mut found = false;
    for service in &mut config.services {
        for game in &mut service.cached_library_games {
            if cached_game_id(service.id.as_str(), game) == game_id {
                game.custom_icon_path = None;
                game.online_icon_path = None;
                found = true;
            }
        }
        for game in &mut service.saved_games {
            if saved_game_id(service.id.as_str(), game) == game_id {
                game.custom_icon_path = None;
                game.online_icon_path = None;
                found = true;
            }
        }
    }
    if !found {
        return Err("Game not found.".into());
    }
    write_config(app, &config)?;
    reconcile_library(app, None)
}

pub fn set_custom_service_icon(
    app: &tauri::AppHandle,
    service_id: &str,
    source: &str,
) -> Result<Vec<GameService>, String> {
    let saved_path = save_custom_icon(app, source, &format!("service-{service_id}"))?;
    let mut config = read_config(app)?;
    let service = config
        .services
        .iter_mut()
        .find(|service| service.id == service_id)
        .ok_or("Service not found.")?;
    service.custom_icon_path = Some(saved_path);
    write_config(app, &config)?;
    reconcile_library(app, None)
}

pub fn reset_service_icon(
    app: &tauri::AppHandle,
    service_id: &str,
) -> Result<Vec<GameService>, String> {
    let mut config = read_config(app)?;
    let service = config
        .services
        .iter_mut()
        .find(|service| service.id == service_id)
        .ok_or("Service not found.")?;
    service.custom_icon_path = None;
    service.automatic_icon_path = None;
    write_config(app, &config)?;
    reconcile_library(app, None)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlineIconResponse {
    api_configured: bool,
    search_result_count: usize,
    icon_count: usize,
    game: OnlineGame,
    icon: OnlineIcon,
}

#[derive(Deserialize)]
struct OnlineGame {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct OnlineIcon {
    id: u64,
    url: String,
    width: u32,
    height: u32,
}

pub fn resolve_online_game_icon(
    app: &tauri::AppHandle,
    game_id: &str,
) -> Result<Vec<GameService>, String> {
    resolve_online_game_icon_inner(app, game_id, false)
}

pub fn retry_game_icon(app: &tauri::AppHandle, game_id: &str) -> Result<Vec<GameService>, String> {
    clear_online_icon(app, game_id)?;
    resolve_online_game_icon_inner(app, game_id, true)
}

pub fn set_steam_grid_db_icon_override(
    app: &tauri::AppHandle,
    game_id: &str,
    icon_id: u64,
) -> Result<Vec<GameService>, String> {
    if icon_id == 0 {
        return Err("Choose a valid SteamGridDB icon ID.".into());
    }
    let mut config = read_config(app)?;
    let mut found = false;
    for service in &mut config.services {
        for game in &mut service.cached_library_games {
            if cached_game_id(service.id.as_str(), game) == game_id {
                game.steam_grid_db_icon_id = Some(icon_id);
                game.online_icon_path = None;
                found = true;
            }
        }
        for game in &mut service.saved_games {
            if saved_game_id(service.id.as_str(), game) == game_id {
                game.steam_grid_db_icon_id = Some(icon_id);
                game.online_icon_path = None;
                found = true;
            }
        }
    }
    if !found {
        return Err("Game not found.".into());
    }
    write_config(app, &config)?;
    resolve_online_game_icon_inner(app, game_id, true)
}

fn clear_online_icon(app: &tauri::AppHandle, game_id: &str) -> Result<(), String> {
    let mut config = read_config(app)?;
    let mut found = false;
    for service in &mut config.services {
        for game in &mut service.cached_library_games {
            if cached_game_id(service.id.as_str(), game) == game_id {
                game.online_icon_path = None;
                found = true;
            }
        }
        for game in &mut service.saved_games {
            if saved_game_id(service.id.as_str(), game) == game_id {
                game.online_icon_path = None;
                found = true;
            }
        }
    }
    if !found {
        return Err("Game not found.".into());
    }
    write_config(app, &config)
}

fn resolve_online_game_icon_inner(
    app: &tauri::AppHandle,
    game_id: &str,
    force: bool,
) -> Result<Vec<GameService>, String> {
    let current = reconcile_library(app, Some(""))?;
    let game = current
        .iter()
        .flat_map(|service| &service.games)
        .find(|game| game.id == game_id)
        .ok_or("Game not found.")?;
    if !force && !game.needs_icon_upgrade {
        return Ok(current);
    }
    let display_name = game.display_name.clone();
    let install_path = game.install_path.clone();
    let executable_path = game.executable_path.clone();
    let executable_name = game.executable_name.clone();
    let config = read_config(app)?;
    let icon_override = config.services.iter().find_map(|service| {
        service
            .cached_library_games
            .iter()
            .find(|item| cached_game_id(&service.id, item) == game_id)
            .and_then(|item| item.steam_grid_db_icon_id)
            .or_else(|| {
                service
                    .saved_games
                    .iter()
                    .find(|item| saved_game_id(&service.id, item) == game_id)
                    .and_then(|item| item.steam_grid_db_icon_id)
            })
    });
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;
    let mut endpoint = format!(
        "https://modx.vortex-prime-emu.com/steamgriddb/icon?q={}",
        urlencoding::encode(&display_name)
    );
    if let Some(icon_id) = icon_override {
        endpoint.push_str(&format!("&iconId={icon_id}"));
    }
    eprintln!(
        "[IconResolver] game={} install={} executable={} executable_name={} local_quality=poor-or-missing steamgriddb_fallback=started query={} icon_override={} api_key_location=cloudflare-worker",
        display_name,
        install_path,
        executable_path.as_deref().unwrap_or("none"),
        executable_name.as_deref().unwrap_or("none"),
        display_name,
        icon_override.map_or_else(|| "none".into(), |id| id.to_string())
    );
    let lookup = client
        .get(endpoint)
        .send()
        .map_err(|error| format!("SteamGridDB icon lookup failed: {error}"))?;
    let lookup_status = lookup.status();
    if !lookup_status.is_success() {
        eprintln!(
            "[IconResolver] game={} steamgriddb_fallback=failed stage=search-or-icon status={}",
            display_name, lookup_status
        );
        return Ok(current);
    }
    let resolved: OnlineIconResponse = lookup
        .json()
        .map_err(|error| format!("SteamGridDB returned invalid icon metadata: {error}"))?;
    eprintln!(
        "[IconResolver] game={} steamgriddb_api_configured={} search_results={} resolved_game_id={} resolved_game_name={} icons_returned={} selected_icon_id={} api_dimensions={}x{}",
        display_name,
        resolved.api_configured,
        resolved.search_result_count,
        resolved.game.id,
        resolved.game.name,
        resolved.icon_count,
        resolved.icon.id,
        resolved.icon.width,
        resolved.icon.height
    );
    let url = reqwest::Url::parse(&resolved.icon.url)
        .map_err(|_| "SteamGridDB returned an invalid icon URL.")?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|host| host == "steamgriddb.com" || host.ends_with(".steamgriddb.com"))
    {
        return Err("SteamGridDB returned an untrusted icon URL.".into());
    }
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("SteamGridDB icon download failed: {error}"))?;
    let download_status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !download_status.is_success()
        || !content_type.to_ascii_lowercase().starts_with("image/")
        || response
            .content_length()
            .is_some_and(|length| length > 4 * 1024 * 1024)
    {
        eprintln!(
            "[IconResolver] game={} steamgriddb_fallback=failed stage=download status={} content_type={}",
            display_name, download_status, content_type
        );
        return Ok(current);
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Ok(current);
    }
    let downloaded_dimensions = image_dimensions_from_bytes(&bytes)
        .ok_or("SteamGridDB downloaded data was not a valid image.")?;
    if downloaded_dimensions.0 == 0 || downloaded_dimensions.1 == 0 {
        return Err("SteamGridDB downloaded an image with invalid dimensions.".into());
    }
    let cache = icon_cache_directory(app)?;
    let destination = cache.join(format!(
        "online-{}-{}.png",
        stable_hash(game_id),
        resolved.icon.id
    ));
    let cached_dimensions = save_image_bytes_as_png(&bytes, &destination)?;
    eprintln!(
        "[IconResolver] game={} steamgriddb_fallback=success icon_url={} downloaded={}x{} cached={}x{} cache_path={} ui_update=pending",
        display_name,
        resolved.icon.url,
        downloaded_dimensions.0,
        downloaded_dimensions.1,
        cached_dimensions.0,
        cached_dimensions.1,
        destination.display()
    );
    let destination = destination.to_string_lossy().to_string();
    let mut config = read_config(app)?;
    for service in &mut config.services {
        for item in &mut service.cached_library_games {
            if cached_game_id(&service.id, item) == game_id {
                item.online_icon_path = Some(destination.clone());
            }
        }
        for item in &mut service.saved_games {
            if saved_game_id(&service.id, item) == game_id {
                item.online_icon_path = Some(destination.clone());
            }
        }
    }
    write_config(app, &config)?;
    let updated = reconcile_library(app, Some(""))?;
    eprintln!(
        "[IconResolver] game={} ui_update=success cache_path={}",
        display_name, destination
    );
    Ok(updated)
}

fn scan_library_root(config: &GameServiceConfig) -> Option<Vec<CachedLibraryGame>> {
    let root = PathBuf::from(expand_environment(&config.main_library_path));
    if !root.is_dir() {
        return None;
    }
    let entries = fs::read_dir(&root).ok()?;
    let mut directories: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().trim().to_string();
            (!name.is_empty() && !is_ignored_directory(&name)).then(|| (name, entry.path()))
        })
        .collect();
    let sibling_names: BTreeSet<String> = directories
        .iter()
        .map(|(name, _)| normalize_name(name))
        .collect();
    directories.retain(|(name, _)| !is_backup_sibling(name, &sibling_names));
    let mut snapshot: Vec<_> = directories
        .into_iter()
        .map(|(display_name, directory)| {
            let executable = choose_primary_executable(&directory, &display_name);
            CachedLibraryGame {
                display_name,
                install_path: directory.to_string_lossy().to_string(),
                executable_path: executable.map(|path| path.to_string_lossy().to_string()),
                custom_icon_path: None,
                online_icon_path: None,
                steam_grid_db_icon_id: None,
            }
        })
        .collect();
    snapshot.sort_by(|a, b| {
        normalize_path(Path::new(&a.install_path)).cmp(&normalize_path(Path::new(&b.install_path)))
    });
    Some(snapshot)
}

fn build_service(config: &GameServiceConfig, icon_cache: &Path) -> GameService {
    let root = PathBuf::from(expand_environment(&config.main_library_path));
    let path_available = root.is_dir();
    let scan_error = (!path_available).then(|| "Library location is unavailable. Known games are being kept while ModX waits for it to return.".into());
    let mut games: Vec<_> = config
        .cached_library_games
        .iter()
        .map(|cached| {
            library_game(
                config,
                cached.display_name.clone(),
                PathBuf::from(&cached.install_path),
                cached.executable_path.as_ref().map(PathBuf::from),
                DiscoverySource::MainLibrary,
                icon_cache,
                IconPaths {
                    custom: cached.custom_icon_path.as_deref(),
                    online: cached.online_icon_path.as_deref(),
                    steam_grid_db_icon_id: cached.steam_grid_db_icon_id,
                },
            )
        })
        .collect();

    for saved in &config.saved_games {
        let executable = PathBuf::from(expand_environment(&saved.executable_path));
        let install = PathBuf::from(expand_environment(&saved.install_path));
        games.push(library_game(
            config,
            saved.display_name.clone(),
            install,
            Some(executable),
            DiscoverySource::SavedProcess,
            icon_cache,
            IconPaths {
                custom: saved.custom_icon_path.as_deref(),
                online: saved.online_icon_path.as_deref(),
                steam_grid_db_icon_id: saved.steam_grid_db_icon_id,
            },
        ));
    }
    let games = reconcile_games(games);
    GameService {
        id: config.id.clone(),
        name: config.name.clone(),
        main_library_path: config.main_library_path.clone(),
        created_at: config.created_at,
        updated_at: config.updated_at,
        path_available,
        games,
        scan_error,
        icon_data_url: icon_from_path(config.custom_icon_path.as_deref(), icon_cache)
            .or_else(|| icon_from_path(config.automatic_icon_path.as_deref(), icon_cache)),
        has_custom_icon: config.custom_icon_path.is_some(),
    }
}

struct IconPaths<'a> {
    custom: Option<&'a str>,
    online: Option<&'a str>,
    steam_grid_db_icon_id: Option<u64>,
}

fn library_game(
    service: &GameServiceConfig,
    display_name: String,
    install: PathBuf,
    executable: Option<PathBuf>,
    source: DiscoverySource,
    icon_cache: &Path,
    icons: IconPaths<'_>,
) -> LibraryGame {
    let install_path = install.to_string_lossy().to_string();
    let executable_path = executable
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let executable_name = executable_path
        .as_ref()
        .and_then(|path| Path::new(path).file_name())
        .map(|name| name.to_string_lossy().to_string());
    let identity = executable_path
        .as_ref()
        .map(|path| normalize_path(Path::new(path)))
        .unwrap_or_else(|| normalize_path(&install));
    let custom_icon = icon_asset_from_path(icons.custom, icon_cache, "custom");
    let executable_icon = executable_path
        .as_ref()
        .and_then(|path| cached_icon_asset(Path::new(path), icon_cache));
    let local_icon = local_install_icon_asset(&install, icon_cache);
    let online_icon = icon_asset_from_path(icons.online, icon_cache, "steamgriddb-cache");
    let high_quality_local = executable_icon
        .clone()
        .filter(IconAsset::high_quality)
        .or_else(|| local_icon.clone().filter(IconAsset::high_quality));
    let needs_icon_upgrade =
        custom_icon.is_none() && online_icon.is_none() && high_quality_local.is_none();
    let selected_icon = custom_icon
        .or(high_quality_local)
        .or(online_icon)
        .or(executable_icon)
        .or(local_icon);
    if let Some(icon) = &selected_icon {
        eprintln!(
            "[IconResolver] game={} install={} executable={} selected_source={} source_dimensions={}x{} rendered_card=50x50 rendered_detail=86x86 steamgriddb_override={}",
            display_name,
            install.display(),
            executable_path.as_deref().unwrap_or("none"),
            icon.source,
            icon.width,
            icon.height,
            icons
                .steam_grid_db_icon_id
                .map_or_else(|| "none".into(), |id| id.to_string())
        );
    } else {
        eprintln!(
            "[IconResolver] game={} install={} executable={} selected_source=none steamgriddb_fallback=pending",
            display_name,
            install.display(),
            executable_path.as_deref().unwrap_or("none")
        );
    }
    LibraryGame {
        id: format!(
            "game-{}",
            stable_hash(&format!("{}:{identity}", service.id))
        ),
        service_id: service.id.clone(),
        display_name,
        install_path,
        executable_path,
        executable_name,
        discovery_source: source,
        is_available: install.is_dir(),
        icon_data_url: selected_icon.map(|icon| icon.data_url),
        has_custom_icon: icons.custom.is_some(),
        needs_icon_upgrade,
    }
}

fn backup_base_name(name: &str) -> Option<String> {
    let lower = name.trim().to_ascii_lowercase();
    let patterns = [
        r" - copy",
        r" copy",
        r" - backup",
        r" backup",
        r"_backup",
        r".backup",
        r" - old",
        r"_old",
        r".old",
    ];
    for marker in patterns {
        if let Some(index) = lower.rfind(marker) {
            let suffix = lower[index + marker.len()..].trim();
            let numbered_copy = suffix.is_empty()
                || (suffix.starts_with('(')
                    && suffix.ends_with(')')
                    && suffix[1..suffix.len() - 1]
                        .chars()
                        .all(|c| c.is_ascii_digit()))
                || (marker.contains("backup")
                    && suffix
                        .chars()
                        .all(|c| c.is_ascii_digit() || c == '-' || c.is_whitespace()));
            if numbered_copy && index > 0 {
                return Some(normalize_name(&name[..index]));
            }
        }
    }
    None
}

fn is_backup_sibling(name: &str, siblings: &BTreeSet<String>) -> bool {
    backup_base_name(name).is_some_and(|base| !base.is_empty() && siblings.contains(&base))
}

fn icon_cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(format!("icons-v{ICON_CACHE_VERSION}"));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn custom_icon_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("custom-icons");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn save_custom_icon(app: &tauri::AppHandle, source: &str, name: &str) -> Result<String, String> {
    let source = Path::new(source);
    if !source.is_file() {
        return Err("Choose an existing image file.".into());
    }
    let extension = source
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "ico") {
        return Err("Choose a PNG, JPG, WebP, or ICO image.".into());
    }
    let destination = custom_icon_directory(app)?.join(format!("{}.png", stable_hash(name)));
    let bytes = fs::read(source).map_err(|error| format!("The icon could not be read: {error}"))?;
    save_image_bytes_as_png(&bytes, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

fn save_image_bytes_as_png(bytes: &[u8], destination: &Path) -> Result<(u32, u32), String> {
    let image = image::load_from_memory(bytes)
        .map_err(|_| "That file is not a supported image.".to_string())?;
    let original = (image.width(), image.height());
    // The cache is a lossless master, not a UI-sized derivative. Cap genuinely
    // oversized artwork, but preserve smaller source pixels exactly: enlarging a
    // 256px executable resource to 512px only creates a larger blurry file.
    let image = if image.width() > MASTER_ICON_EDGE || image.height() > MASTER_ICON_EDGE {
        image.thumbnail(MASTER_ICON_EDGE, MASTER_ICON_EDGE)
    } else {
        image
    };
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let verified = save_png_bytes_verified(&output.into_inner(), destination)?;
    eprintln!(
        "[IconResolver] cache_write path={} original={}x{} cached={}x{} cache_format=PNG validated=yes",
        destination.display(),
        original.0,
        original.1,
        verified.0,
        verified.1
    );
    Ok(verified)
}

fn cached_game_id(service_id: &str, game: &CachedLibraryGame) -> String {
    let identity = game
        .executable_path
        .as_ref()
        .map(|path| normalize_path(Path::new(path)))
        .unwrap_or_else(|| normalize_path(Path::new(&game.install_path)));
    format!("game-{}", stable_hash(&format!("{service_id}:{identity}")))
}

fn saved_game_id(service_id: &str, game: &SavedGame) -> String {
    let identity = normalize_path(Path::new(&game.executable_path));
    format!("game-{}", stable_hash(&format!("{service_id}:{identity}")))
}

#[derive(Clone)]
struct IconAsset {
    data_url: String,
    width: u32,
    height: u32,
    source: &'static str,
}

impl IconAsset {
    fn high_quality(&self) -> bool {
        self.width >= HIGH_QUALITY_ICON_EDGE && self.height >= HIGH_QUALITY_ICON_EDGE
    }
}

fn cached_icon_asset(executable: &Path, cache: &Path) -> Option<IconAsset> {
    let cached = cached_executable_icon_path(executable, cache)?;
    icon_asset_from_path(cached.to_str(), cache, "executable-cache")
}

fn cached_executable_icon_path(executable: &Path, cache: &Path) -> Option<PathBuf> {
    if !executable.is_file() {
        return None;
    }
    let metadata = fs::metadata(executable).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    let key = stable_hash(&format!(
        "icon-v{ICON_CACHE_VERSION}:{}:{}:{}",
        normalize_path(executable),
        metadata.len(),
        modified
    ));
    let cached = cache.join(format!("{key}.png"));
    if cached.is_file() && is_high_quality_image(&cached) {
        return Some(cached);
    }
    let extracted = extract_executable_icon(executable)
        .map_err(|error| {
            eprintln!(
                "[IconResolver] source=executable path={} extraction=failed reason={error}",
                executable.display()
            );
            error
        })
        .ok()?;
    let dimensions = image_dimensions_from_bytes(&extracted)?;
    if dimensions.0 < HIGH_QUALITY_ICON_EDGE || dimensions.1 < HIGH_QUALITY_ICON_EDGE {
        eprintln!(
            "[IconResolver] source=executable path={} extraction=low-quality decoded={}x{}",
            executable.display(),
            dimensions.0,
            dimensions.1
        );
    }
    save_image_bytes_as_png(&extracted, &cached).ok()?;
    let cached_dimensions = image_dimensions(&cached)?;
    eprintln!(
        "[IconResolver] source=executable path={} decoded={}x{} cached={}x{} cache_path={} cache_format=PNG",
        executable.display(),
        dimensions.0,
        dimensions.1,
        cached_dimensions.0,
        cached_dimensions.1,
        cached.display()
    );
    Some(cached)
}

fn icon_from_path(value: Option<&str>, cache: &Path) -> Option<String> {
    icon_asset_from_path(value, cache, "saved-cache").map(|asset| asset.data_url)
}

fn icon_asset_from_path(
    value: Option<&str>,
    cache: &Path,
    source: &'static str,
) -> Option<IconAsset> {
    let path = Path::new(value?);
    let bytes = normalized_image_bytes(path, cache)?;
    let (width, height) = image_dimensions_from_bytes(&bytes)?;
    eprintln!(
        "[IconResolver] source={source} path={} decoded={}x{} cache_format=PNG",
        path.display(),
        width,
        height
    );
    Some(IconAsset {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        width,
        height,
        source,
    })
}

fn normalized_image_bytes(path: &Path, cache: &Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    let key = stable_hash(&format!(
        "image-v{ICON_CACHE_VERSION}:{}:{}:{}",
        normalize_path(path),
        metadata.len(),
        modified
    ));
    let cached = cache.join(format!("{key}.png"));
    if cached.is_file() {
        return fs::read(cached).ok();
    }
    let original = fs::read(path).ok()?;
    let image = image::load_from_memory(&original).ok()?;
    let original_dimensions = (image.width(), image.height());
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        && image.width() <= MASTER_ICON_EDGE
        && image.height() <= MASTER_ICON_EDGE
    {
        return Some(original);
    }
    let image = if image.width() > MASTER_ICON_EDGE || image.height() > MASTER_ICON_EDGE {
        image.thumbnail(MASTER_ICON_EDGE, MASTER_ICON_EDGE)
    } else {
        image
    };
    let output_dimensions = (image.width(), image.height());
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, image::ImageFormat::Png).ok()?;
    let bytes = output.into_inner();
    save_png_bytes_verified(&bytes, &cached).ok()?;
    eprintln!(
        "[IconResolver] source=image-file path={} original={}x{} cached={}x{} cache_path={} cache_format=PNG",
        path.display(),
        original_dimensions.0,
        original_dimensions.1,
        output_dimensions.0,
        output_dimensions.1,
        cached.display()
    );
    Some(bytes)
}

fn local_install_icon_asset(install: &Path, cache: &Path) -> Option<IconAsset> {
    let path = local_install_icon_path(install)?;
    icon_asset_from_path(path.to_str(), cache, "local-resource")
}

fn local_install_icon_path(install: &Path) -> Option<PathBuf> {
    if !install.is_dir() {
        return None;
    }
    let mut pending = vec![(install.to_path_buf(), 0usize)];
    let mut candidates = Vec::<(i32, PathBuf)>::new();
    let mut inspected = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 2 || inspected >= 250 {
            continue;
        }
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            inspected += 1;
            if inspected > 250 {
                break;
            }
            let path = entry.path();
            if path.is_dir() && depth < 2 {
                pending.push((path, depth + 1));
                continue;
            }
            let extension = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "ico" | "png" | "jpg" | "jpeg" | "webp") {
                continue;
            }
            let stem = normalize_name(&path.file_stem().unwrap_or_default().to_string_lossy());
            let score = if stem == "gameicon" || stem == "appicon" || stem == "launchericon" {
                200
            } else if stem == "icon" || stem == "logo" {
                160
            } else if extension == "ico" && depth == 0 {
                140
            } else if stem.contains("icon") {
                90
            } else if stem.contains("logo") {
                60
            } else {
                continue;
            } - depth as i32 * 15;
            candidates.push((score, path));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    candidates.into_iter().map(|(_, path)| path).find(|path| {
        image::ImageReader::open(path)
            .ok()
            .and_then(|reader| reader.with_guessed_format().ok())
            .and_then(|reader| reader.decode().ok())
            .is_some()
    })
}

#[cfg(target_os = "windows")]
fn extract_executable_icon(executable: &Path) -> Result<Vec<u8>, String> {
    match crate::windows_icon::extract_png(executable, 256) {
        Ok((bytes, _, _)) => Ok(bytes),
        Err(high_resolution_error) => {
            let bytes = systemicons::get_icon(&executable.to_string_lossy(), 64)
                .map_err(|_| high_resolution_error)?;
            let generic = systemicons::get_icon("exe", 64).ok();
            if bytes.is_empty() || generic.as_ref().is_some_and(|generic| generic == &bytes) {
                return Err("no distinct embedded executable icon was found".into());
            }
            Ok(bytes)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_executable_icon(executable: &Path) -> Result<Vec<u8>, String> {
    systemicons::get_icon(&executable.to_string_lossy(), 256)
        .map_err(|error| format!("system icon extraction failed: {error:?}"))
}

fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let reader = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

fn image_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    image::load_from_memory(bytes)
        .ok()
        .map(|image| (image.width(), image.height()))
}

fn is_high_quality_image(path: &Path) -> bool {
    image_dimensions(path).is_some_and(|(width, height)| {
        width >= HIGH_QUALITY_ICON_EDGE && height >= HIGH_QUALITY_ICON_EDGE
    })
}

fn is_current_icon_cache_path(path: &Path) -> bool {
    path.parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == format!("icons-v{ICON_CACHE_VERSION}"))
}

fn save_png_bytes_verified(bytes: &[u8], destination: &Path) -> Result<(u32, u32), String> {
    let dimensions = image_dimensions_from_bytes(bytes)
        .ok_or("The icon data could not be decoded as an image.")?;
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err("The icon has invalid dimensions.".into());
    }
    let temporary = destination.with_extension("png.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    let verified =
        image_dimensions(&temporary).ok_or("The written icon cache file could not be decoded.")?;
    if verified != dimensions
        || fs::metadata(&temporary).map_or(true, |metadata| metadata.len() == 0)
    {
        let _ = fs::remove_file(&temporary);
        return Err("The written icon cache file failed validation.".into());
    }
    if destination.is_file() {
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
    Ok(verified)
}

fn find_service_executable(config: &GameServiceConfig) -> Option<PathBuf> {
    let wanted = normalize_name(&config.name);
    let root = PathBuf::from(expand_environment(&config.main_library_path));
    let mut candidates = Vec::<(i32, PathBuf)>::new();
    for directory in root.ancestors().take(4) {
        let entries = fs::read_dir(directory).ok()?;
        for entry in entries.flatten().filter(|entry| entry.path().is_file()) {
            let path = entry.path();
            if path
                .extension()
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe"))
            {
                continue;
            }
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            if is_ignored_executable(&stem.to_ascii_lowercase()) {
                continue;
            }
            let normalized = normalize_name(&stem);
            let mut score = 0;
            if normalized == wanted {
                score += 200;
            } else if !wanted.is_empty()
                && (wanted.contains(&normalized) || normalized.contains(&wanted))
            {
                score += 80;
            }
            score -= directory
                .components()
                .count()
                .abs_diff(root.components().count()) as i32
                * 10;
            candidates.push((score, path));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let nearby = candidates
        .into_iter()
        .find(|(score, _)| *score >= 50)
        .map(|(_, path)| path);
    nearby.or_else(|| find_registered_launcher(&config.name))
}

#[cfg(windows)]
fn find_registered_launcher(service_name: &str) -> Option<PathBuf> {
    use winreg::{RegKey, enums::*};
    let wanted = normalize_name(service_name);
    let mut candidates = Vec::<(i32, PathBuf)>::new();
    for root in [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
    ] {
        for registry_path in [
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(uninstall) = root.open_subkey(registry_path) else {
                continue;
            };
            for key_name in uninstall.enum_keys().flatten() {
                let Ok(entry) = uninstall.open_subkey(key_name) else {
                    continue;
                };
                let display_name: String = entry.get_value("DisplayName").unwrap_or_default();
                let normalized_display = normalize_name(&display_name);
                if wanted.is_empty()
                    || normalized_display.is_empty()
                    || !(wanted.contains(&normalized_display)
                        || normalized_display.contains(&wanted))
                {
                    continue;
                }
                let display_icon: String = entry.get_value("DisplayIcon").unwrap_or_default();
                let icon_path = display_icon
                    .trim()
                    .trim_matches('"')
                    .split(",")
                    .next()
                    .unwrap_or_default()
                    .trim_matches('"');
                let icon_stem = Path::new(icon_path)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                if Path::new(icon_path).is_file() && !is_ignored_executable(&icon_stem) {
                    candidates.push((
                        if normalized_display == wanted {
                            250
                        } else {
                            140
                        },
                        PathBuf::from(icon_path),
                    ));
                }
                // Some registrations (including Steam on common Windows installs)
                // expose only an uninstaller as DisplayIcon and omit
                // InstallLocation. The uninstaller is not an icon source, but its
                // parent still tells us where to look for the real launcher.
                if let Some(parent) = Path::new(icon_path).parent()
                    && let Ok(files) = fs::read_dir(parent)
                {
                    for file in files.flatten().filter(|file| file.path().is_file()) {
                        let path = file.path();
                        if path
                            .extension()
                            .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe"))
                        {
                            continue;
                        }
                        let raw_stem = path
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_ascii_lowercase();
                        if is_ignored_executable(&raw_stem) {
                            continue;
                        }
                        let stem = normalize_name(&raw_stem);
                        if stem == wanted {
                            candidates.push((240, path));
                        }
                    }
                }
                let install: String = entry.get_value("InstallLocation").unwrap_or_default();
                if let Ok(files) = fs::read_dir(install) {
                    for file in files.flatten().filter(|file| file.path().is_file()) {
                        let path = file.path();
                        if path
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                        {
                            let raw_stem = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_ascii_lowercase();
                            if is_ignored_executable(&raw_stem) {
                                continue;
                            }
                            let stem = normalize_name(
                                &path.file_stem().unwrap_or_default().to_string_lossy(),
                            );
                            let score = if stem == wanted {
                                220
                            } else if normalized_display.contains(&stem) {
                                120
                            } else {
                                0
                            };
                            if score > 0 {
                                candidates.push((score, path));
                            }
                        }
                    }
                }
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    candidates.into_iter().next().map(|(_, path)| path)
}

#[cfg(not(windows))]
fn find_registered_launcher(_service_name: &str) -> Option<PathBuf> {
    None
}

fn reconcile_games(games: Vec<LibraryGame>) -> Vec<LibraryGame> {
    let mut unique = BTreeMap::<String, LibraryGame>::new();
    for game in games {
        let install_key = normalize_path(Path::new(&game.install_path));
        let executable_key = game
            .executable_path
            .as_ref()
            .map(|path| normalize_path(Path::new(path)));
        let key = executable_key.unwrap_or(install_key);
        unique
            .entry(key)
            .and_modify(|current| {
                if matches!(game.discovery_source, DiscoverySource::SavedProcess) {
                    *current = game.clone();
                }
            })
            .or_insert(game);
    }
    let mut games: Vec<_> = unique.into_values().collect();
    games.sort_by(|a, b| {
        a.display_name
            .to_ascii_lowercase()
            .cmp(&b.display_name.to_ascii_lowercase())
    });
    games
}

fn choose_primary_executable(directory: &Path, display_name: &str) -> Option<PathBuf> {
    let wanted = normalize_name(display_name);
    let mut pending = vec![(directory.to_path_buf(), 0usize)];
    let mut visited = BTreeSet::new();
    let mut candidates = Vec::<(i32, u64, PathBuf)>::new();
    while let Some((path, depth)) = pending.pop() {
        if depth > 5 || !visited.insert(normalize_path(&path)) {
            continue;
        }
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                if depth < 5 && !is_ignored_directory(&name) {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if path
                .extension()
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
            {
                continue;
            }
            let stem = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let lower = stem.to_ascii_lowercase();
            if is_ignored_executable(&lower) {
                continue;
            }
            let normalized = normalize_name(&stem);
            let mut score = 100 - depth as i32 * 8;
            if normalized == wanted {
                score += 160;
            } else if !normalized.is_empty()
                && (wanted.contains(&normalized) || normalized.contains(&wanted))
            {
                score += 70;
            }
            if lower.ends_with("-win64-shipping") || lower.ends_with("_win64_shipping") {
                score += 45;
            }
            let size = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            candidates.push((score, size, path));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    candidates.into_iter().next().map(|(_, _, path)| path)
}

fn is_ignored_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "_commonredist"
            | "redist"
            | "redistributable"
            | "redistributables"
            | "installer"
            | "installers"
            | "support"
            | "prerequisites"
            | "directx"
            | "dotnet"
    )
}

fn is_ignored_executable(name: &str) -> bool {
    [
        "uninstall",
        "unins",
        "crash",
        "reporter",
        "crashpad",
        "setup",
        "installer",
        "updater",
        "update",
        "config",
        "configuration",
        "redistributable",
        "redist",
        "easyanticheat",
        "battleye",
        "vc_redist",
        "dxsetup",
        "unitycrashhandler",
        "helper",
        "prereq",
        "benchmark",
    ]
    .iter()
    .any(|term| name.contains(term))
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("game-services.json"))
}

fn read_config(app: &tauri::AppHandle) -> Result<LibraryConfig, String> {
    let file = config_file(app)?;
    if !file.exists() {
        return Ok(LibraryConfig::default());
    }
    serde_json::from_str(&fs::read_to_string(file).map_err(|error| error.to_string())?)
        .map_err(|error| format!("The saved game-service configuration is invalid: {error}"))
}

fn write_config(app: &tauri::AppHandle, config: &LibraryConfig) -> Result<(), String> {
    let file = config_file(app)?;
    let temporary = file.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, file).map_err(|error| error.to_string())
}

fn canonical_existing_directory(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(expand_environment(value.trim().trim_matches('"')));
    if !path.is_dir() {
        return Err("Choose an existing main library folder.".into());
    }
    fs::canonicalize(path)
        .map_err(|error| format!("That library folder could not be opened: {error}"))
}

fn canonical_existing_file(path: &Path) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err("The selected process executable is unavailable.".into());
    }
    fs::canonicalize(path)
        .map_err(|error| format!("The executable location could not be opened: {error}"))
}

fn normalize_path(path: &Path) -> String {
    let value = expand_environment(&path.to_string_lossy());
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn expand_environment(value: &str) -> String {
    let mut result = value.to_string();
    for (key, replacement) in env::vars() {
        result = result.replace(&format!("%{key}%"), &replacement);
    }
    result
}

fn stable_hash(value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_are_normalized_case_insensitively() {
        assert_eq!(
            normalize_path(Path::new(r"D:/Games/Game A/")),
            normalize_path(Path::new(r"d:\games\game a"))
        );
    }

    #[test]
    fn saved_process_record_wins_without_creating_a_duplicate() {
        let service = GameServiceConfig {
            id: "service-a".into(),
            name: "A".into(),
            main_library_path: r"D:\Games".into(),
            created_at: 1,
            updated_at: 1,
            saved_games: Vec::new(),
            cached_library_games: Vec::new(),
            custom_icon_path: None,
            automatic_icon_path: None,
        };
        let discovered = library_game(
            &service,
            "Game A".into(),
            PathBuf::from(r"D:\Games\Game A"),
            Some(PathBuf::from(r"D:\Games\Game A\GameA.exe")),
            DiscoverySource::MainLibrary,
            Path::new(r"D:\Cache"),
            IconPaths {
                custom: None,
                online: None,
                steam_grid_db_icon_id: None,
            },
        );
        let saved = library_game(
            &service,
            "My Game A".into(),
            PathBuf::from(r"D:\Games\Game A"),
            Some(PathBuf::from(r"d:\games\game a\gamea.exe")),
            DiscoverySource::SavedProcess,
            Path::new(r"D:\Cache"),
            IconPaths {
                custom: None,
                online: None,
                steam_grid_db_icon_id: None,
            },
        );
        let games = reconcile_games(vec![discovered, saved]);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].display_name, "My Game A");
    }

    #[test]
    fn different_services_keep_independent_game_identity() {
        let path = r"D:\Games\Game A";
        assert_ne!(
            stable_hash(&format!("service-a:{path}")),
            stable_hash(&format!("service-b:{path}"))
        );
    }

    #[test]
    fn helper_executables_are_rejected() {
        assert!(is_ignored_executable("unitycrashhandler64"));
        assert!(is_ignored_executable("easyanticheat_launcher"));
        assert!(!is_ignored_executable("game-win64-shipping"));
    }

    #[test]
    fn backup_suffix_requires_a_real_sibling() {
        let siblings = BTreeSet::from([
            normalize_name("Grand Theft Auto V"),
            normalize_name("Grand Theft Auto V - Copy"),
            normalize_name("Copycat Adventure"),
        ]);
        assert!(is_backup_sibling("Grand Theft Auto V - Copy", &siblings));
        assert!(!is_backup_sibling("Copycat Adventure", &siblings));
        assert!(!is_backup_sibling("Missing Original - Copy", &siblings));
    }

    #[test]
    fn numbered_and_dated_backups_are_normalized() {
        assert_eq!(
            backup_base_name("Game - Copy (3)"),
            Some(normalize_name("Game"))
        );
        assert_eq!(
            backup_base_name("Game - Backup 2026"),
            Some(normalize_name("Game"))
        );
        assert_eq!(backup_base_name("Game.old"), Some(normalize_name("Game")));
    }

    #[test]
    fn real_folder_reconciliation_adds_removes_and_filters_backups() {
        let root = std::env::temp_dir().join(format!("modx-library-test-{}", now()));
        fs::create_dir_all(root.join("Game A")).unwrap();
        fs::create_dir_all(root.join("Game A - Copy")).unwrap();
        let service = GameServiceConfig {
            id: "service-test".into(),
            name: "Test".into(),
            main_library_path: root.to_string_lossy().to_string(),
            created_at: 1,
            updated_at: 1,
            saved_games: Vec::new(),
            cached_library_games: Vec::new(),
            custom_icon_path: None,
            automatic_icon_path: None,
        };

        let first = scan_library_root(&service).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].display_name, "Game A");

        fs::create_dir_all(root.join("Game B")).unwrap();
        let second = scan_library_root(&service).unwrap();
        assert_eq!(second.len(), 2);

        fs::remove_dir_all(root.join("Game A")).unwrap();
        let third = scan_library_root(&service).unwrap();
        assert_eq!(
            third.len(),
            2,
            "the former copy becomes visible when its original is gone"
        );
        assert!(third.iter().any(|game| game.display_name == "Game B"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_windows_executable_icon_is_extracted_and_cached() {
        let windows = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let executable = PathBuf::from(windows).join("System32").join("notepad.exe");
        let cache = std::env::temp_dir().join(format!("modx-icon-test-{}", now()));
        fs::create_dir_all(&cache).unwrap();
        let icon = cached_icon_asset(&executable, &cache).expect("Notepad should expose an icon");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        assert!(icon.width >= 128 && icon.height >= 128);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        fs::remove_dir_all(cache).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installed_steam_and_black_flag_icons_extract_as_high_resolution_masters() {
        let candidates = [
            PathBuf::from(r"C:\Program Files (x86)\Steam\steam.exe"),
            PathBuf::from(
                r"D:\SteamLibrary\steamapps\common\Assassin's Creed Black Flag Resynced\ACBlackFlag.exe",
            ),
            PathBuf::from(
                r"D:\SteamLibrary\steamapps\common\Assassin's Creed IV Black Flag\AC4BFSP.exe",
            ),
        ];
        for executable in candidates.into_iter().filter(|path| path.is_file()) {
            let (bytes, width, height) = crate::windows_icon::extract_png(&executable, 256)
                .unwrap_or_else(|error| panic!("{}: {error}", executable.display()));
            assert_eq!((width, height), (256, 256));
            assert_eq!(image_dimensions_from_bytes(&bytes), Some((256, 256)));

            let cache = std::env::temp_dir().join(format!(
                "modx-real-icon-cache-test-{}-{}",
                now(),
                stable_hash(&executable.to_string_lossy())
            ));
            fs::create_dir_all(&cache).unwrap();
            let cached = cached_icon_asset(&executable, &cache)
                .unwrap_or_else(|| panic!("{} did not cache", executable.display()));
            assert_eq!((cached.width, cached.height), (256, 256));
            fs::remove_dir_all(cache).unwrap();
        }
    }

    #[test]
    fn local_icon_file_is_used_when_executable_icon_is_missing() {
        let root = std::env::temp_dir().join(format!("modx-local-icon-test-{}", now()));
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let icon_path = root.join("gameicon.png");
        image::RgbaImage::from_pixel(96, 96, image::Rgba([24, 180, 120, 255]))
            .save(&icon_path)
            .unwrap();
        let icon =
            local_install_icon_asset(&root, &cache).expect("local gameicon.png should resolve");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abbreviated_root_ico_is_used_for_older_games() {
        let root = std::env::temp_dir().join(format!("modx-root-ico-test-{}", now()));
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let icon_path = root.join("ACBF_PC.ico");
        image::RgbaImage::from_pixel(128, 128, image::Rgba([18, 42, 92, 255]))
            .save_with_format(&icon_path, image::ImageFormat::Ico)
            .unwrap();
        let icon = local_install_icon_asset(&root, &cache)
            .expect("a branded root ICO with an abbreviated filename should resolve");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_local_artwork_returns_no_icon_instead_of_a_fake_placeholder() {
        let root = std::env::temp_dir().join(format!("modx-no-icon-test-{}", now()));
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        assert!(local_install_icon_asset(&root, &cache).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_game_icon_survives_config_serialization() {
        let expected = r"C:\Users\Player\AppData\Roaming\ModX\custom-icons\game.png";
        let game = SavedGame {
            id: "saved-game".into(),
            display_name: "Game".into(),
            install_path: r"D:\Games\Game".into(),
            executable_path: r"D:\Games\Game\Game.exe".into(),
            executable_name: "Game.exe".into(),
            custom_icon_path: Some(expected.into()),
            online_icon_path: None,
            steam_grid_db_icon_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let restored: SavedGame =
            serde_json::from_str(&serde_json::to_string(&game).unwrap()).unwrap();
        assert_eq!(restored.custom_icon_path.as_deref(), Some(expected));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installed_steam_launcher_is_found_through_local_metadata() {
        let Some(executable) = find_registered_launcher("steam") else {
            eprintln!("Steam is not installed; skipping installed-launcher integration check");
            return;
        };
        assert!(executable.is_file());
        assert_eq!(
            executable
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase(),
            "steam.exe"
        );
    }
}
