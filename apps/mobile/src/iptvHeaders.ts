export function iptvHeaders(url: string, headers: Record<string, string> = {}): Record<string, string> {
  const output: Record<string, string> = {};
  let guid: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-tjxy-iptv-guid') guid = value;
    else if (name.toLowerCase() !== 'cookie') output[name] = value;
  }
  if (new URL(url).hostname === 'player-api.yangshipin.cn' && guid && /^[a-z0-9_]{1,64}$/.test(guid)) {
    output.Cookie = `guid=${guid}; versionName=99.99.99; versionCode=999999; vplatform=109; platformVersion=Chrome; deviceModel=148; newLogin=1; pc_version=1.1.16`;
  }
  return output;
}
