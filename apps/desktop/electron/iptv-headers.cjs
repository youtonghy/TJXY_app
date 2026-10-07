function iptvHeaders(target, headers) {
  const output = {};
  let guid;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'x-tjxy-iptv-guid') guid = String(value);
    else output[name] = value;
  }
  if (target.hostname === 'player-api.yangshipin.cn' && guid && /^[a-z0-9_]{1,64}$/.test(guid)) {
    // Only public protocol metadata is synthesized; page cookies are never forwarded.
    output.Cookie = `guid=${guid}; versionName=99.99.99; versionCode=999999; vplatform=109; platformVersion=Chrome; deviceModel=148; newLogin=1; pc_version=1.1.16`;
  }
  return output;
}
module.exports = { iptvHeaders };
