//! Scout's tray and menu bar panel: one icon that shows the worst state across every device, and a panel that lists the services behind it.

pub mod hub;
pub mod icon;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Rect, State, WebviewWindow, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Notify;

use hub::{Config, HubReply};
use icon::IconState;

const TRAY_ID: &str = "scout";
const POLL_CLOSED: Duration = Duration::from_secs(30);
const POLL_OPEN: Duration = Duration::from_secs(5);
// A click on the icon first takes focus away from the panel, which hides it; without this the same click would open it again.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Link {
    Unconfigured,
    Unreachable,
    Refused,
    Ok,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    link: Link,
    /// The hub's /api/tray body as sent, for the panel to parse.
    body: Option<String>,
    detail: Option<String>,
}

struct Shared {
    config: Mutex<Config>,
    secret: Mutex<Option<String>>,
    client: reqwest::Client,
    snapshot: Mutex<Snapshot>,
    etag: Mutex<Option<String>>,
    shown: Mutex<Option<(IconState, bool, String)>>,
    open: AtomicBool,
    last_hide: Mutex<Option<Instant>>,
    wake: Notify,
    text: HashMap<String, String>,
    config_dir: std::path::PathBuf,
}

type Handle = Arc<Shared>;

fn fill(template: &str, n: usize) -> String {
    template.replace("{n}", &n.to_string())
}

impl Shared {
    fn line(&self, key: &str) -> String {
        self.text.get(key).cloned().unwrap_or_default()
    }

    fn credentials(&self) -> Option<(Config, String)> {
        let config = self.config.lock().ok()?.clone();
        let secret = self.secret.lock().ok()?.clone()?;
        if config.hub_url.is_empty() || config.client_id.is_empty() {
            return None;
        }
        Some((config, secret))
    }
}

#[cfg(target_os = "windows")]
fn bar_is_dark(_app: &AppHandle) -> bool {
    use std::os::windows::process::CommandExt;
    // The taskbar follows its own setting, which the app theme API does not report.
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "SystemUsesLightTheme"])
        .creation_flags(0x0800_0000)
        .output();
    match output {
        Ok(out) => !String::from_utf8_lossy(&out.stdout).trim_end().ends_with("0x1"),
        Err(_) => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn bar_is_dark(app: &AppHandle) -> bool {
    app.get_webview_window("panel").and_then(|w| w.theme().ok()).map(|t| t == tauri::Theme::Dark).unwrap_or(true)
}

fn icon_for(link: Link, body: Option<&str>) -> (IconState, usize) {
    if link != Link::Ok {
        return (IconState::Unreachable, 0);
    }
    let Some(value) = body.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok()) else {
        return (IconState::Unreachable, 0);
    };
    let sum = |key: &str| -> usize {
        value["machines"].as_array().map(|ms| ms.iter().map(|m| m["counts"][key].as_u64().unwrap_or(0) as usize).sum()).unwrap_or(0)
    };
    match value["state"].as_str() {
        Some("down") => (IconState::Down, sum("down")),
        Some("changed") => (IconState::Changed, sum("changed")),
        _ => (IconState::Up, 0),
    }
}

fn tooltip(shared: &Shared, link: Link, state: IconState, n: usize) -> String {
    match (link, state) {
        (Link::Unconfigured, _) => shared.line("tipUnconfigured"),
        (Link::Ok, IconState::Up) => shared.line("tipUp"),
        (Link::Ok, IconState::Changed) => fill(&shared.line("tipChanged"), n),
        (Link::Ok, IconState::Down) => fill(&shared.line("tipDown"), n),
        _ => shared.line("tipUnreachable"),
    }
}

fn paint(app: &AppHandle, shared: &Shared, snapshot: &Snapshot) {
    let (state, n) = icon_for(snapshot.link, snapshot.body.as_deref());
    let dark = bar_is_dark(app);
    let tip = tooltip(shared, snapshot.link, state, n);
    let wanted = (state, dark, tip.clone());
    let Ok(mut shown) = shared.shown.lock() else { return };
    if shown.as_ref() == Some(&wanted) {
        return;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(Image::new_owned(icon::render(state, dark), icon::SIZE, icon::SIZE)));
        let _ = tray.set_tooltip(Some(tip));
    }
    *shown = Some(wanted);
}

async fn refresh(app: &AppHandle, shared: &Handle) {
    let next = match shared.credentials() {
        None => Snapshot { link: Link::Unconfigured, body: None, detail: None },
        Some((config, secret)) => {
            let etag = shared.etag.lock().ok().and_then(|e| e.clone());
            let have_body = shared.snapshot.lock().map(|s| s.link == Link::Ok && s.body.is_some()).unwrap_or(false);
            let reply = hub::request(&shared.client, &config, &secret, "GET", "/api/tray", None, if have_body { etag.as_deref() } else { None }).await;
            match reply.status {
                304 => return paint_current(app, shared),
                200 => {
                    if let Ok(mut slot) = shared.etag.lock() {
                        *slot = reply.etag.clone();
                    }
                    Snapshot { link: Link::Ok, body: Some(reply.body), detail: None }
                }
                301 | 302 | 303 | 307 | 308 | 401 | 403 => Snapshot { link: Link::Refused, body: None, detail: None },
                0 => Snapshot { link: Link::Unreachable, body: None, detail: Some(reply.body) },
                code => Snapshot { link: Link::Unreachable, body: None, detail: Some(format!("the hub answered {code}")) },
            }
        }
    };
    if let Ok(mut slot) = shared.snapshot.lock() {
        *slot = next.clone();
    }
    paint(app, shared, &next);
    let _ = app.emit("snapshot", &next);
}

fn paint_current(app: &AppHandle, shared: &Handle) {
    // The theme of the bar can change while the data does not.
    let current = shared.snapshot.lock().map(|s| s.clone()).ok();
    if let Some(snapshot) = current {
        paint(app, shared, &snapshot);
    }
}

fn place(app: &AppHandle, window: &WebviewWindow, rect: &Rect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let Ok(outer) = window.outer_size() else { return };
    let (w, h) = (outer.width as f64, outer.height as f64);
    let gap = 8.0 * scale;
    let (mut x, mut y) = (pos.x + size.width / 2.0 - w / 2.0, pos.y - h - gap);
    if let Ok(Some(monitor)) = app.monitor_from_point(pos.x, pos.y) {
        let (mx, my) = (monitor.position().x as f64, monitor.position().y as f64);
        let (mw, mh) = (monitor.size().width as f64, monitor.size().height as f64);
        x = x.clamp(mx + gap, (mx + mw - w - gap).max(mx + gap));
        // A bar along the top (the macOS menu bar) opens the panel below it; a taskbar along the bottom opens it above.
        y = if pos.y < my + mh / 2.0 { pos.y + size.height + gap } else { pos.y - h - gap };
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn show_panel(app: &AppHandle, shared: &Handle, rect: Option<&Rect>) {
    let Some(window) = app.get_webview_window("panel") else { return };
    if let Some(rect) = rect {
        place(app, &window, rect);
    }
    let _ = window.show();
    let _ = window.set_focus();
    shared.open.store(true, Ordering::SeqCst);
    shared.wake.notify_one();
    let _ = app.emit("panel-open", ());
}

fn hide_panel(app: &AppHandle, shared: &Handle) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.hide();
    }
    shared.open.store(false, Ordering::SeqCst);
    if let Ok(mut stamp) = shared.last_hide.lock() {
        *stamp = Some(Instant::now());
    }
}

fn toggle_panel(app: &AppHandle, shared: &Handle, rect: &Rect) {
    let visible = app.get_webview_window("panel").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible {
        hide_panel(app, shared);
        return;
    }
    let just_hidden = shared.last_hide.lock().ok().and_then(|s| *s).map(|t| t.elapsed() < REOPEN_GUARD).unwrap_or(false);
    if !just_hidden {
        show_panel(app, shared, Some(rect));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigOut {
    hub_url: String,
    client_id: String,
    has_secret: bool,
    theme: String,
}

#[tauri::command]
fn get_snapshot(shared: State<'_, Handle>) -> Snapshot {
    shared.snapshot.lock().map(|s| s.clone()).unwrap_or(Snapshot { link: Link::Unreachable, body: None, detail: None })
}

#[tauri::command]
fn get_config(shared: State<'_, Handle>) -> ConfigOut {
    let config = shared.config.lock().map(|c| c.clone()).unwrap_or_default();
    let has_secret = shared.secret.lock().map(|s| s.is_some()).unwrap_or(false);
    ConfigOut { hub_url: config.hub_url, client_id: config.client_id, has_secret, theme: if config.theme.is_empty() { "system".to_string() } else { config.theme } }
}

#[tauri::command]
fn get_text(shared: State<'_, Handle>) -> HashMap<String, String> {
    shared.text.clone()
}

#[tauri::command]
async fn hub_request(shared: State<'_, Handle>, method: String, path: String, body: Option<String>) -> Result<HubReply, String> {
    let (config, secret) = shared.credentials().ok_or_else(|| shared.line("bannerUnconfigured"))?;
    Ok(hub::request(&shared.client, &config, &secret, &method, &path, body, None).await)
}

#[tauri::command]
async fn save_config(app: AppHandle, shared: State<'_, Handle>, hub_url: String, client_id: String, secret: Option<String>) -> Result<(), String> {
    let hub_url = hub::normalize_hub_url(&hub_url)?;
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("the client ID is empty".to_string());
    }
    let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(value) = &secret {
        hub::store_secret(value)?;
    }
    let config = {
        let mut slot = shared.config.lock().map_err(|e| e.to_string())?;
        slot.hub_url = hub_url;
        slot.client_id = client_id;
        slot.clone()
    };
    if let Some(value) = secret {
        *shared.secret.lock().map_err(|e| e.to_string())? = Some(value);
    }
    hub::save_config(&shared.config_dir, &config)?;
    let (config, secret) = shared.credentials().ok_or_else(|| shared.line("bannerUnconfigured"))?;
    let reply = hub::request(&shared.client, &config, &secret, "GET", "/api/tray", None, None).await;
    if let Ok(mut slot) = shared.etag.lock() {
        *slot = None;
    }
    let handle = Arc::clone(&shared);
    refresh(&app, &handle).await;
    match reply.status {
        200 => Ok(()),
        301 | 302 | 303 | 307 | 308 | 401 | 403 => Err(shared.line("bannerRefused")),
        0 => Err(reply.body),
        code => Err(format!("the hub answered {code}")),
    }
}

#[tauri::command]
fn set_theme(shared: State<'_, Handle>, theme: String) -> Result<(), String> {
    let config = {
        let mut slot = shared.config.lock().map_err(|e| e.to_string())?;
        slot.theme = theme;
        slot.clone()
    };
    hub::save_config(&shared.config_dir, &config)
}

#[tauri::command]
fn open_portal(app: AppHandle, shared: State<'_, Handle>) -> Result<(), String> {
    let url = shared.config.lock().map_err(|e| e.to_string())?.hub_url.clone();
    if url.is_empty() {
        return Err(shared.line("bannerUnconfigured"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_panel(app: AppHandle, shared: State<'_, Handle>) {
    hide_panel(&app, &shared);
}

#[tauri::command]
fn refresh_now(shared: State<'_, Handle>) {
    if let Ok(mut etag) = shared.etag.lock() {
        *etag = None;
    }
    shared.wake.notify_one();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(shared) = app.try_state::<Handle>() {
                show_panel(app, &shared, None);
            }
        }))
        .invoke_handler(tauri::generate_handler![get_snapshot, get_config, get_text, hub_request, save_config, set_theme, open_portal, close_panel, refresh_now])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let text: HashMap<String, String> = serde_json::from_str(include_str!("../../ui/text.json"))?;
            let shared: Handle = Arc::new(Shared {
                config: Mutex::new(hub::load_config(&config_dir)),
                secret: Mutex::new(hub::load_secret()),
                client: hub::client(),
                snapshot: Mutex::new(Snapshot { link: Link::Unconfigured, body: None, detail: None }),
                etag: Mutex::new(None),
                shown: Mutex::new(None),
                open: AtomicBool::new(false),
                last_hide: Mutex::new(None),
                wake: Notify::new(),
                text,
                config_dir,
            });
            app.manage(Arc::clone(&shared));

            let handle = app.handle().clone();
            let open_item = MenuItem::with_id(app, "open", shared.line("trayMenuOpenScout"), true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", shared.line("trayMenuSettings"), true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", shared.line("trayMenuQuit"), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &settings_item, &quit_item])?;

            let dark = bar_is_dark(&handle);
            let menu_shared = Arc::clone(&shared);
            let click_shared = Arc::clone(&shared);
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::new_owned(icon::render(IconState::Unreachable, dark), icon::SIZE, icon::SIZE))
                .tooltip(shared.line("tipUnconfigured"))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        let _ = open_portal_inner(app, &menu_shared);
                    }
                    "settings" => {
                        show_panel(app, &menu_shared, None);
                        let _ = app.emit("show-connect", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        toggle_panel(tray.app_handle(), &click_shared, &rect);
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("panel") {
                let focus_handle = handle.clone();
                let focus_shared = Arc::clone(&shared);
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        hide_panel(&focus_handle, &focus_shared);
                    }
                });
            }

            let poll_shared = Arc::clone(&shared);
            tauri::async_runtime::spawn(async move {
                loop {
                    refresh(&handle, &poll_shared).await;
                    let wait = if poll_shared.open.load(Ordering::SeqCst) { POLL_OPEN } else { POLL_CLOSED };
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = poll_shared.wake.notified() => {}
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the tray app runs");
}

fn open_portal_inner(app: &AppHandle, shared: &Handle) -> Result<(), String> {
    let url = shared.config.lock().map_err(|e| e.to_string())?.hub_url.clone();
    if url.is_empty() {
        show_panel(app, shared, None);
        let _ = app.emit("show-connect", ());
        return Ok(());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}
