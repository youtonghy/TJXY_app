import { desktopAwareFetch } from '../api/apiBase';
import type { IptvChannel } from './iptvChannels';
import { rewritePlaylistUrls } from './iptvDevice';
import { md5Hex } from './iptvDeviceCrypto';
import { IptvResolveError } from './iptvApi';

export const IPTV_WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Referer: 'https://www.yangshipin.cn/',
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function resolveIptvWeb(channel: IptvChannel, fetchImpl: FetchLike = desktopAwareFetch): Promise<string> {
  const { runKeygen, buildTicket, buildCKey, randStr, base36 } = await import('./iptvWebWasm.js');
  const now = Date.now();
  const guid = `${base36(now)}_${randStr(13)}`;
  const headers = { ...IPTV_WEB_HEADERS, Origin: 'https://www.yangshipin.cn', 'X-TJXY-IPTV-Guid': guid, yspappid: '519748109' };
  const requestJson = async (url: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new IptvResolveError(`web engine HTTP ${response.status}`);
    const value = await response.json() as { data?: Record<string, unknown> };
    if (!value.data || typeof value.data !== 'object') throw new IptvResolveError('invalid web engine response');
    return value.data;
  };
  const authBody: Record<string, string> = { pid: channel.pid, guid, appid: 'ysp_pc', rand_str: randStr(10) };
  authBody.signature = md5Hex(sorted(authBody) + 'n@7QKk%YeSjfw%22');
  const auth = await requestJson('https://player-api.yangshipin.cn/v1/player/auth', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(authBody).toString(),
  });
  if (typeof auth.token !== 'string' || auth.ts === undefined) throw new IptvResolveError('web auth failed');
  const state = { guid, yspappid: '519748109', version: 'v1', host: 'www.yangshipin.cn', protocol: 'https:', token: '', input: '', ts: String(now) };
  const tokenQuery = new URLSearchParams({
    yspappid: state.yspappid, guid, vappid: '59306155',
    vsecret: 'b42702bf7309a179d102f3d51b1add2fda0bc7ada64cb801', raw: '1',
    version: 'v1', ts: state.ts, rnd: runKeygen(state).getRnd(),
  });
  const token = await requestJson(`https://h5access.yangshipin.cn/web/open/token?${tokenQuery}`, { headers: IPTV_WEB_HEADERS });
  if (typeof token.token !== 'string') throw new IptvResolveError('web open token failed');
  const body: Record<string, string | number> = {
    adjust: 1, appVer: 'V1.0.0', app_version: 'V1.0.0', cKey: buildCKey(channel.sid, Math.floor(now / 1000), guid),
    channel: 'ysp_tx', cmd: '2', cnlid: channel.sid, defn: channel.defn || 'fhd', devid: 'devid', dtype: '1',
    encryptVer: '8.1', guid, livepid: channel.pid, otype: 'ojson', platform: '5910204', sphttps: '1', stream: '2',
  };
  const bodyKeys = Object.keys(body).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  const bodyMd5 = md5Hex(bodyKeys.map((key) => `${key}=${body[key]}`).join('&'));
  const requestId = `999999${randStr(10)}${now}`;
  const sdkInput = `${bodyMd5}-${guid}-1-${requestId}`;
  const sign = runKeygen({ ...state, token: token.token, input: sdkInput, ts: String(token.ts ?? now) }).getSign();
  body.rand_str = randStr(10);
  body.signature = md5Hex(sorted(body) + '0f$IVHi9Qno?G');
  const live = await requestJson('https://player-api.yangshipin.cn/v1/player/get_live_info', {
    method: 'POST', headers: {
      ...headers, 'Content-Type': 'application/json;charset=UTF-8', yspsdkinput: bodyMd5,
      yspsdksign: `${sign}-${sdkInput}`, seqId: '1', 'request-id': requestId, yspPlayerToken: auth.token,
      yspticket: buildTicket(channel.pid, String(auth.ts), channel.sid, guid),
    }, body: JSON.stringify(body),
  });
  if (typeof live.playurl !== 'string') throw new IptvResolveError('web engine missing playurl');
  const url = live.playurl + (typeof live.extended_param === 'string' ? live.extended_param : '');
  const response = await fetchImpl(url, { headers: IPTV_WEB_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new IptvResolveError(`web playlist HTTP ${response.status}`);
  const text = await response.text();
  if (!text.includes('#EXTM3U')) throw new IptvResolveError('invalid web playlist');
  return rewritePlaylistUrls(text, response.url || url);
}

function sorted(value: Record<string, string | number>): string {
  return Object.keys(value).sort().map((key) => `${key}=${value[key]}`).join('&');
}
