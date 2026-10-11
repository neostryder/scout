//! Talking to the Scout hub: the saved connection, the service-token secret, and the one request path the panel is allowed to use.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "dev.neostryder.scout-tray";
const SECRET_USER: &str = "hub-service-token-secret";

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub hub_url: String,
    #[serde(default)]
    pub client_id: String,
    /// "system", "dark", or "light"; the panel's own look, not the tray icon's.
    #[serde(default)]
    pub theme: String,
    /// True once the person turns off Start at login; the tray starts at login until then.
    #[serde(default)]
    pub autostart_disabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HubReply {
    /// 0 when the hub could not be reached at all.
    pub status: u16,
    pub body: String,
    pub etag: Option<String>,
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

pub fn load_config(dir: &Path) -> Config {
    std::fs::read_to_string(config_path(dir)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn save_config(dir: &Path, config: &Config) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = config_path(dir);
    let temp = dir.join("config.json.tmp");
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())
}

pub fn load_secret() -> Option<String> {
    keyring::Entry::new(SERVICE, SECRET_USER).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

pub fn store_secret(secret: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, SECRET_USER).and_then(|entry| entry.set_password(secret)).map_err(|e| e.to_string())
}

/// The hub address as a base with no trailing slash. https only, except for a local hub during development.
pub fn normalize_hub_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).map_err(|_| "the hub address is not a valid URL".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("the hub address must start with https://".to_string()),
    }
    if url.host_str().is_none() {
        return Err("the hub address has no host".to_string());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("the hub address must not include a path".to_string());
    }
    Ok(trimmed.to_string())
}

/// The panel may only reach the tray read model, its rules, and the service-action endpoints. Anything else is refused before a request is made.
pub fn allowed(method: &str, target: &str) -> bool {
    let path = target.split('?').next().unwrap_or("");
    let ok_method = |allowed: &[&str]| allowed.contains(&method);
    match path {
        "/api/tray" => ok_method(&["GET"]),
        "/api/tray/rules" => ok_method(&["GET", "PUT"]),
        "/api/tray/hide" => ok_method(&["POST"]),
        "/api/services/actions" => ok_method(&["GET"]),
        "/api/services/actions/plan" | "/api/services/actions/run" => ok_method(&["POST"]),
        _ => false,
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("scout-tray/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("the HTTP client builds")
}

pub async fn request(client: &reqwest::Client, config: &Config, secret: &str, method: &str, target: &str, body: Option<String>, etag: Option<&str>) -> HubReply {
    if !allowed(method, target) {
        return HubReply { status: 0, body: "that request is not allowed from the tray".to_string(), etag: None };
    }
    let url = format!("{}{}", config.hub_url, target);
    let verb = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => reqwest::Method::PUT,
    };
    let mut builder = client.request(verb, url).header("CF-Access-Client-Id", &config.client_id).header("CF-Access-Client-Secret", secret);
    if let Some(tag) = etag {
        builder = builder.header("If-None-Match", tag);
    }
    if let Some(text) = body {
        builder = builder.header("Content-Type", "application/json").body(text);
    }
    match builder.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let etag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = response.text().await.unwrap_or_default();
            HubReply { status, body, etag }
        }
        Err(err) => HubReply { status: 0, body: err.without_url().to_string(), etag: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hub_address_must_be_https_or_a_local_hub() {
        assert_eq!(normalize_hub_url(" https://scout.example.com/ ").unwrap(), "https://scout.example.com");
        assert_eq!(normalize_hub_url("http://127.0.0.1:4870").unwrap(), "http://127.0.0.1:4870");
        assert!(normalize_hub_url("http://scout.example.com").is_err());
        assert!(normalize_hub_url("https://scout.example.com/api").is_err());
        assert!(normalize_hub_url("scout.example.com").is_err());
        assert!(normalize_hub_url("").is_err());
    }

    #[test]
    fn only_the_tray_and_action_endpoints_are_reachable() {
        assert!(allowed("GET", "/api/tray"));
        assert!(allowed("GET", "/api/services/actions?limit=5&machine=eru"));
        assert!(allowed("POST", "/api/services/actions/plan"));
        assert!(allowed("POST", "/api/services/actions/run"));
        assert!(allowed("PUT", "/api/tray/rules"));
        assert!(allowed("POST", "/api/tray/hide"));
        assert!(!allowed("POST", "/api/tray"));
        assert!(!allowed("DELETE", "/api/tray/rules"));
        assert!(!allowed("GET", "/api/services"));
        assert!(!allowed("GET", "/api/tray/../secrets"));
        assert!(!allowed("GET", "/api/trayx"));
        assert!(!allowed("GET", "//evil.example/api/tray"));
    }

    #[test]
    fn a_config_round_trips_and_a_missing_one_is_empty() {
        let dir = std::env::temp_dir().join(format!("scout-tray-test-{}", std::process::id()));
        assert_eq!(load_config(&dir), Config::default());
        let config = Config { hub_url: "https://h.example".into(), client_id: "abc.access".into(), theme: "dark".into(), autostart_disabled: false };
        save_config(&dir, &config).unwrap();
        assert_eq!(load_config(&dir), config);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Needs a local dev hub on 127.0.0.1:4899 (the "scout-dev-tray" launch entry); run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn a_local_hub_answers_the_tray_request() {
        let config = Config { hub_url: "http://127.0.0.1:4899".into(), client_id: "test.access".into(), theme: String::new(), autostart_disabled: false };
        let client = client();
        let first = request(&client, &config, "secret", "GET", "/api/tray", None, None).await;
        assert_eq!(first.status, 200, "{}", first.body);
        assert!(first.body.contains("\"machines\""));
        let etag = first.etag.clone().expect("the hub sends an ETag");
        let second = request(&client, &config, "secret", "GET", "/api/tray", None, Some(&etag)).await;
        assert_eq!(second.status, 304);
        let refused = request(&client, &config, "secret", "GET", "/api/machines", None, None).await;
        assert_eq!(refused.status, 0);
    }
}
