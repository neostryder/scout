//! Scout's tray and menu bar panel: one icon that shows the worst state across every device, and a panel that lists the services behind it.

pub mod autostart;
pub mod hub;
pub mod icon;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
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
// How long a just-opened panel is given to take focus before the macOS watcher may hide it.
#[cfg(target_os = "macos")]
const FOCUS_GRACE: Duration = Duration::from_millis(1200);

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
    opened_at: Mutex<Option<Instant>>,
    /// Where the tray icon last reported itself, so the menu entries can place the panel under it the way a left click does.
    tray_rect: Mutex<Option<Rect>>,
    wake: Notify,
    text: HashMap<String, String>,
    config_dir: std::path::PathBuf,
}

type Handle = Arc<Shared>;

/// Appends one line to panel.log in the config folder so a panel that misbehaves can be traced afterwards; the file is cut back once it passes 64 KB.
fn trace(shared: &Shared, what: &str) {
    use std::io::Write;
    let path = shared.config_dir.join("panel.log");
    if std::fs::metadata(&path).map(|m| m.len() > 65_536).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{at} {what}");
    }
}

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

/// One short line per machine with a reading, such as "Eru 12% CPU 38% RAM 20% VRAM". `vram_template` stands in for `{vram}` on a machine that has video memory, and is dropped on one that does not.
/// Whole lines are dropped to stay inside the 127-character limit of a Windows tooltip.
fn meter_lines(template: &str, vram_template: &str, body: Option<&str>, room: usize) -> String {
    let Some(value) = body.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok()) else { return String::new() };
    let mut out = String::new();
    for machine in value["machines"].as_array().into_iter().flatten() {
        let (Some(name), Some(cpu), Some(mem)) = (machine["name"].as_str(), machine["meters"]["cpuPct"].as_f64(), machine["meters"]["memPct"].as_f64()) else { continue };
        let vram = machine["meters"]["vramPct"].as_f64().map(|v| vram_template.replace("{vram}", &format!("{:.0}", v))).unwrap_or_default();
        let line = template.replace("{name}", name).replace("{cpu}", &format!("{:.0}", cpu)).replace("{mem}", &format!("{:.0}", mem)).replace("{vram}", &vram);
        if out.chars().count() + 1 + line.chars().count() > room {
            break;
        }
        out.push('\n');
        out.push_str(&line);
    }
    out
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
    let mut tip = tooltip(shared, snapshot.link, state, n);
    if snapshot.link == Link::Ok {
        let room = 126usize.saturating_sub(tip.chars().count());
        tip.push_str(&meter_lines(&shared.line("tipMeters"), &shared.line("tipMetersVram"), snapshot.body.as_deref(), room));
    }
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

/// The rectangle to place the panel against: the one the caller has, else the last one the icon reported, else the icon's own answer right now.
fn pick_rect<T>(given: Option<T>, remembered: Option<T>, live: impl FnOnce() -> Option<T>) -> Option<T> {
    given.or(remembered).or_else(live)
}

fn event_rect(event: &TrayIconEvent) -> Option<Rect> {
    match event {
        TrayIconEvent::Click { rect, .. }
        | TrayIconEvent::DoubleClick { rect, .. }
        | TrayIconEvent::Enter { rect, .. }
        | TrayIconEvent::Move { rect, .. }
        | TrayIconEvent::Leave { rect, .. } => Some(rect.clone()),
        _ => None,
    }
}

fn show_panel(app: &AppHandle, shared: &Handle, rect: Option<&Rect>) {
    let Some(window) = app.get_webview_window("panel") else { return };
    let remembered = shared.tray_rect.lock().ok().and_then(|r| r.clone());
    let live = || app.tray_by_id(TRAY_ID).and_then(|tray| tray.rect().ok().flatten());
    let rect = pick_rect(rect.cloned(), remembered, live);
    if let Some(rect) = &rect {
        place(app, &window, rect);
    }
    let _ = window.show();
    let _ = window.set_focus();
    trace(shared, &format!("show placed={} visible={:?} focused={:?}", rect.is_some(), window.is_visible(), window.is_focused()));
    shared.open.store(true, Ordering::SeqCst);
    if let Ok(mut stamp) = shared.opened_at.lock() {
        *stamp = Some(Instant::now());
    }
    shared.wake.notify_one();
    let _ = app.emit("panel-open", ());
}

fn hide_panel(app: &AppHandle, shared: &Handle) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.hide();
        trace(shared, &format!("hide visible={:?}", window.is_visible()));
    }
    shared.open.store(false, Ordering::SeqCst);
    if let Ok(mut stamp) = shared.last_hide.lock() {
        *stamp = Some(Instant::now());
    }
}

fn toggle_panel(app: &AppHandle, shared: &Handle, rect: &Rect) {
    let visible = app.get_webview_window("panel").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    trace(shared, &format!("toggle visible={visible} open={}", shared.open.load(Ordering::SeqCst)));
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
fn quit_app(app: AppHandle) {
    // A clean exit is not restarted by the login supervisor, so the tray stays closed until the next login.
    app.exit(0);
}

/// Registers or removes the login entry on a worker thread, because the scheduler call can take a moment, and remembers the choice.
fn set_autostart(shared: &Handle, on: bool) {
    let config = shared.config.lock().ok().map(|mut slot| {
        slot.autostart_disabled = !on;
        slot.clone()
    });
    let dir = shared.config_dir.clone();
    if let Some(config) = &config {
        let _ = hub::save_config(&dir, config);
    }
    std::thread::spawn(move || {
        let result = match (on, std::env::current_exe()) {
            (true, Ok(exe)) => autostart::enable(&exe, &dir),
            (true, Err(error)) => Err(error.to_string()),
            (false, _) => autostart::disable(),
        };
        if let Err(message) = result {
            eprintln!("start at login: {message}");
        }
    });
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
        .invoke_handler(tauri::generate_handler![get_snapshot, get_config, get_text, hub_request, save_config, set_theme, open_portal, close_panel, refresh_now, quit_app])
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
                opened_at: Mutex::new(None),
                tray_rect: Mutex::new(None),
                wake: Notify::new(),
                text,
                config_dir,
            });
            app.manage(Arc::clone(&shared));

            let handle = app.handle().clone();
            let open_item = MenuItem::with_id(app, "open", shared.line("trayMenuOpenScout"), true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", shared.line("trayMenuSettings"), true, None::<&str>)?;
            let autostart_off = shared.config.lock().map(|c| c.autostart_disabled).unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(app, "autostart", shared.line("trayMenuAutostart"), true, !autostart_off, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", shared.line("trayMenuQuit"), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &settings_item, &autostart_item, &quit_item])?;
            let toggle_item = autostart_item.clone();

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
                        trace(&menu_shared, "menu open");
                        let _ = open_portal_inner(app, &menu_shared);
                    }
                    "settings" => {
                        trace(&menu_shared, "menu settings");
                        show_panel(app, &menu_shared, None);
                        let _ = app.emit("show-connect", ());
                    }
                    "autostart" => set_autostart(&menu_shared, toggle_item.is_checked().unwrap_or(true)),
                    "quit" => {
                        trace(&menu_shared, "menu quit");
                        show_panel(app, &menu_shared, None);
                        let _ = app.emit("confirm-quit", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let Some(rect) = event_rect(&event) {
                        if let Ok(mut slot) = click_shared.tray_rect.lock() {
                            *slot = Some(rect);
                        }
                    }
                    if let TrayIconEvent::Click { button, button_state, .. } = &event {
                        trace(&click_shared, &format!("tray click {button:?} {button_state:?}"));
                    }
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        toggle_panel(tray.app_handle(), &click_shared, &rect);
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("panel") {
                let focus_handle = handle.clone();
                let focus_shared = Arc::clone(&shared);
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(focused) = event {
                        trace(&focus_shared, &format!("focus {focused}"));
                        if !*focused {
                            hide_panel(&focus_handle, &focus_shared);
                        }
                    }
                });
            }

            // On macOS a menu bar panel can stay open without ever receiving a focus-lost event, and a floating window covers the icon's own menu. The panel therefore stays at the normal window level, and a watcher hides it once it has been open a moment and no longer has focus.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("panel") {
                    let _ = window.set_always_on_top(false);
                }
                let watch_handle = handle.clone();
                let watch_shared = Arc::clone(&shared);
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        if !watch_shared.open.load(Ordering::SeqCst) {
                            continue;
                        }
                        let settled = watch_shared.opened_at.lock().ok().and_then(|s| *s).map(|t| t.elapsed() > FOCUS_GRACE).unwrap_or(false);
                        let focused = watch_handle.get_webview_window("panel").and_then(|w| w.is_focused().ok()).unwrap_or(true);
                        if settled && !focused {
                            trace(&watch_shared, "watcher hides");
                            hide_panel(&watch_handle, &watch_shared);
                        }
                    }
                });
            }

            if !cfg!(debug_assertions) && !autostart_off {
                set_autostart(&shared, true);
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

#[cfg(test)]
mod tests {
    use super::{meter_lines, pick_rect};

    const T: &str = "{name} {cpu}% CPU {mem}% RAM{vram}";
    const V: &str = " {vram}% VRAM";
    const BODY: &str = r#"{"machines":[{"name":"Eru","meters":{"cpuPct":12.4,"memPct":38.2,"vramPct":20.4}},{"name":"Bilbo","meters":null},{"name":"Stacks","meters":null},{"name":"Gamemaster","meters":{"cpuPct":62,"memPct":74,"vramPct":null}}]}"#;

    #[test]
    fn one_line_per_machine_with_a_reading_and_video_memory_where_there_is_some() {
        assert_eq!(meter_lines(T, V, Some(BODY), 200), "
Eru 12% CPU 38% RAM 20% VRAM
Gamemaster 62% CPU 74% RAM");
    }

    #[test]
    fn whole_lines_are_dropped_when_there_is_no_room() {
        assert_eq!(meter_lines(T, V, Some(BODY), 40), "
Eru 12% CPU 38% RAM 20% VRAM");
        assert_eq!(meter_lines(T, V, Some(BODY), 3), "");
    }

    #[test]
    fn no_body_or_unreadable_body_adds_nothing() {
        assert_eq!(meter_lines("{name}", V, None, 100), "");
        assert_eq!(meter_lines("{name}", V, Some("not json"), 100), "");
    }

    #[test]
    fn a_menu_entry_without_a_rectangle_places_the_panel_at_the_remembered_one() {
        assert_eq!(pick_rect(Some(1), Some(2), || Some(3)), Some(1));
        assert_eq!(pick_rect(None, Some(2), || Some(3)), Some(2));
    }

    #[test]
    fn with_nothing_remembered_the_icon_is_asked_and_unplaced_only_when_it_has_no_answer() {
        assert_eq!(pick_rect(None, None, || Some(3)), Some(3));
        assert_eq!(pick_rect::<i32>(None, None, || None), None);
    }

    #[test]
    fn the_live_lookup_is_skipped_when_a_rectangle_is_already_known() {
        let mut asked = false;
        let _ = pick_rect(None, Some(2), || {
            asked = true;
            Some(3)
        });
        assert!(!asked);
    }
}
