//! Minimal blocking client for the TJXY server endpoints the native player
//! needs. Mirrors `packages/client-api` (auth header, paths, payloads) so the
//! player never depends on the web `/app` playback page.

use reqwest::blocking::Client;
use reqwest::{Method, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Session {
    origin: Url,
    token: String,
    http: Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MediaItem {
    pub name: Option<String>,
    pub user_data: Option<UserData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UserData {
    pub playback_position_ticks: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlaybackInfo {
    #[serde(default)]
    pub media_sources: Vec<PlaybackSource>,
    pub play_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlaybackSource {
    pub id: String,
    pub is_default: Option<bool>,
    pub is_live: Option<bool>,
    pub supports_direct_play: Option<bool>,
    pub direct_stream_url: Option<String>,
    #[serde(default)]
    pub media_streams: Vec<PlaybackStream>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlaybackStream {
    #[serde(rename = "Type")]
    pub kind: Option<String>,
    pub language: Option<String>,
    pub display_title: Option<String>,
    pub delivery_url: Option<String>,
    pub is_external: Option<bool>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct PlaybackTicket {
    pub id: String,
    pub stream_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CurrentUser {
    id: String,
}

#[derive(Clone, Copy, Debug)]
pub enum PlaybackReport {
    Start,
    Progress,
    Stop,
}

#[derive(Clone, Debug)]
pub struct PlaybackState {
    pub item_id: String,
    pub media_source_id: String,
    pub play_session_id: String,
    pub position_ticks: i64,
}

impl Session {
    pub fn new(server_origin: &str, token: &str) -> Result<Self, String> {
        let origin = parse_origin(server_origin)?;
        if token.trim().is_empty() {
            return Err("请先登录后再播放。".into());
        }
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("HTTP client: {error}"))?;
        Ok(Self {
            origin,
            token: token.to_string(),
            http,
        })
    }

    pub fn item(&self, item_id: &str) -> Result<MediaItem, String> {
        self.json(Method::GET, &format!("/Items/{}", encode(item_id)), None)
    }

    pub fn current_user_id(&self) -> Result<String, String> {
        Ok(self.json::<CurrentUser>(Method::GET, "/Users/Me", None)?.id)
    }

    pub fn playback_info(&self, item_id: &str) -> Result<PlaybackInfo, String> {
        self.json(
            Method::POST,
            &format!("/Items/{}/PlaybackInfo", encode(item_id)),
            Some(serde_json::json!({})),
        )
    }

    pub fn issue_ticket(
        &self,
        item_id: &str,
        media_source_id: &str,
        play_session_id: &str,
    ) -> Result<PlaybackTicket, String> {
        self.json(
            Method::POST,
            &format!("/Items/{}/PlaybackTicket", encode(item_id)),
            Some(serde_json::json!({
                "MediaSourceId": media_source_id,
                "PlaySessionId": play_session_id,
            })),
        )
    }

    pub fn revoke_ticket(&self, ticket_id: &str) -> Result<(), String> {
        self.empty(
            Method::DELETE,
            &format!("/PlaybackTickets/{}", encode(ticket_id)),
            None,
        )
    }

    pub fn report(&self, kind: PlaybackReport, state: &PlaybackState) -> Result<(), String> {
        let path = match kind {
            PlaybackReport::Start => "/Sessions/Playing",
            PlaybackReport::Progress => "/Sessions/Playing/Progress",
            PlaybackReport::Stop => "/Sessions/Playing/Stopped",
        };
        self.empty(
            Method::POST,
            path,
            Some(serde_json::json!({
                "ItemId": state.item_id,
                "MediaSourceId": state.media_source_id,
                "PlaySessionId": state.play_session_id,
                "PositionTicks": state.position_ticks,
            })),
        )
    }

    pub fn mark_played(&self, user_id: &str, item_id: &str) -> Result<(), String> {
        self.empty(
            Method::POST,
            &format!("/Users/{}/PlayedItems/{}", encode(user_id), encode(item_id)),
            None,
        )
    }

    /// Downloads an external subtitle. Only same-origin URLs are fetched so the
    /// access token is never sent to a third party.
    pub fn subtitle_text(&self, delivery_url: &str) -> Result<String, String> {
        let url = self.resolve_same_origin(delivery_url)?;
        let response = self
            .authorized(Method::GET, url)
            .send()
            .map_err(|error| format!("字幕下载失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "字幕下载失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        response
            .text()
            .map_err(|error| format!("字幕读取失败：{error}"))
    }

    /// Resolves a server-relative or absolute URL and rejects anything that
    /// does not point at the connected server.
    pub fn resolve_same_origin(&self, value: &str) -> Result<Url, String> {
        let url = self
            .origin
            .join(value)
            .map_err(|_| "播放地址无效。".to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("播放地址不被允许。".into());
        }
        let same_origin = url.scheme() == self.origin.scheme()
            && url.host_str() == self.origin.host_str()
            && url.port_or_known_default() == self.origin.port_or_known_default();
        if !same_origin {
            return Err("播放地址必须属于当前连接的服务器。".into());
        }
        Ok(url)
    }

    fn authorized(&self, method: Method, url: Url) -> reqwest::blocking::RequestBuilder {
        self.http
            .request(method, url)
            .header("Accept", "application/json")
            .header(
                "Authorization",
                format!("MediaBrowser Token=\"{}\"", self.token),
            )
    }

    fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::blocking::Response, String> {
        let url = self
            .origin
            .join(path)
            .map_err(|_| "请求地址无效。".to_string())?;
        let mut request = self.authorized(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .map_err(|error| format!("无法连接服务器：{error}"))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        Err(match status.as_u16() {
            401 => "登录已失效，请重新登录。".into(),
            403 => "你没有权限播放此内容。".into(),
            404 => "此内容已不存在。".into(),
            code => format!("服务器返回错误（HTTP {code}）"),
        })
    }

    fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, String> {
        self.send(method, path, body)?
            .json::<T>()
            .map_err(|error| format!("服务器响应无效：{error}"))
    }

    fn empty(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<(), String> {
        self.send(method, path, body).map(|_| ())
    }
}

/// Direct-play sources in preference order: the server default first, then the
/// remaining sources in server order. mpv can play any container, so unlike
/// the browser there is no container filter.
pub fn playable_sources(sources: &[PlaybackSource]) -> Vec<PlaybackSource> {
    let mut playable: Vec<PlaybackSource> = sources
        .iter()
        .filter(|source| {
            !source.id.is_empty()
                && source.is_live != Some(true)
                && source.supports_direct_play != Some(false)
                && source
                    .direct_stream_url
                    .as_deref()
                    .is_some_and(|url| !url.is_empty())
        })
        .cloned()
        .collect();
    playable.sort_by_key(|source| source.is_default != Some(true));
    playable
}

fn parse_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "服务器地址无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("服务器地址无效。".into());
    }
    let mut origin = url;
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    Ok(origin)
}

fn encode(segment: &str) -> String {
    let mut url = Url::parse("http://segment.invalid/").expect("static URL is valid");
    url.path_segments_mut()
        .expect("http URL has path segments")
        .push(segment);
    url.path().trim_start_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(origin: &str) -> Session {
        Session::new(origin, "token").unwrap()
    }

    fn source(id: &str, default: bool) -> PlaybackSource {
        PlaybackSource {
            id: id.into(),
            is_default: Some(default),
            is_live: None,
            supports_direct_play: None,
            direct_stream_url: Some(format!("/Videos/{id}/stream")),
            media_streams: Vec::new(),
        }
    }

    #[test]
    fn requires_a_token() {
        assert!(Session::new("http://127.0.0.1:8096", " ").is_err());
    }

    #[test]
    fn accepts_same_origin_relative_and_absolute_urls() {
        let session = session("https://example.test/app/");
        assert_eq!(
            session
                .resolve_same_origin("/Videos/1/stream?PlaybackTicket=secret")
                .unwrap()
                .as_str(),
            "https://example.test/Videos/1/stream?PlaybackTicket=secret"
        );
        assert!(session
            .resolve_same_origin("https://example.test:443/Videos/1/stream")
            .is_ok());
    }

    #[test]
    fn rejects_cross_origin_credentials_and_fragments() {
        let session = session("https://example.test");
        assert!(session
            .resolve_same_origin("https://cdn.example.test/video")
            .is_err());
        assert!(session
            .resolve_same_origin("https://user@example.test/video")
            .is_err());
        assert!(session.resolve_same_origin("/video#fragment").is_err());
    }

    #[test]
    fn prefers_default_direct_play_sources() {
        let mut live = source("live", false);
        live.is_live = Some(true);
        let mut missing_url = source("missing", false);
        missing_url.direct_stream_url = None;
        let ordered = playable_sources(&[
            source("a", false),
            live,
            source("b", true),
            missing_url,
            source("c", false),
        ]);
        let ids: Vec<_> = ordered.iter().map(|source| source.id.as_str()).collect();
        assert_eq!(ids, ["b", "a", "c"]);
    }

    #[test]
    fn encodes_path_segments() {
        assert_eq!(encode("a/b c"), "a%2Fb%20c");
    }
}
