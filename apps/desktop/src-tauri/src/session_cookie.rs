//! Recovers the access token of a "remember me" sign-in. After a restart the
//! /app client keeps no token in web storage and authenticates only with the
//! server's HttpOnly `tjxy_session` cookie, whose value is the access token.
//! The cookie lives in tauri-plugin-http's jar, which the plugin persists to
//! its cache directory on every `Set-Cookie`; it is read with the same
//! `cookie_store` crate so domain, path, `Secure` and expiry rules match.

use reqwest::Url;
use std::io::ErrorKind;
use tauri::{AppHandle, Manager};

/// File name tauri-plugin-http uses for its persisted cookie jar.
const COOKIE_JAR_FILE: &str = ".cookies";
const SESSION_COOKIE: &str = "tjxy_session";

pub fn session_token(app: &AppHandle, server_origin: &str) -> Result<Option<String>, String> {
    let url = Url::parse(server_origin).map_err(|_| "服务器地址无效。".to_string())?;
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位登录 Cookie：{error}"))?
        .join(COOKIE_JAR_FILE);
    let jar = match std::fs::read_to_string(&path) {
        Ok(jar) => jar,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取登录 Cookie：{error}")),
    };
    token_from_jar(&jar, &url)
}

fn token_from_jar(jar: &str, url: &Url) -> Result<Option<String>, String> {
    if jar.trim().is_empty() {
        return Ok(None);
    }
    let store = cookie_store::serde::load(jar.as_bytes(), |cookie| serde_json::from_str(cookie))
        .map_err(|error| format!("无法解析登录 Cookie：{error}"))?;
    let token = store
        .get_request_values(url)
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string());
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jar(domain: &str, expires: &str) -> String {
        format!(
            r#"[{{"raw_cookie":"tjxy_session=secret; Path=/; HttpOnly; Secure; SameSite=Lax","path":["/",true],"domain":{{"HostOnly":"{domain}"}},"expires":{{"AtUtc":"{expires}"}}}}]"#
        )
    }

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn reads_the_session_cookie_for_the_server() {
        let jar = jar("media.example.test", "2999-01-01T00:00:00Z");
        assert_eq!(
            token_from_jar(&jar, &url("https://media.example.test")).unwrap(),
            Some("secret".into())
        );
    }

    #[test]
    fn ignores_other_hosts_expired_and_insecure_requests() {
        let valid = jar("media.example.test", "2999-01-01T00:00:00Z");
        assert_eq!(token_from_jar(&valid, &url("https://other.example.test")).unwrap(), None);
        assert_eq!(token_from_jar(&valid, &url("http://media.example.test")).unwrap(), None);
        let expired = jar("media.example.test", "2000-01-01T00:00:00Z");
        assert_eq!(token_from_jar(&expired, &url("https://media.example.test")).unwrap(), None);
    }

    #[test]
    fn treats_an_empty_jar_as_signed_out() {
        assert_eq!(token_from_jar("", &url("https://media.example.test")).unwrap(), None);
    }
}
