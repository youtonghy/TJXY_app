export function runKeygen(state: {
  guid: string; yspappid: string; version: string; host: string; protocol: string;
  token: string; input: string; ts: string;
}): { getRnd(): string; getSign(): string };
export function buildTicket(pid: string, authTs: string, cnlid: string, guid: string): string;
export function buildCKey(cnlid: string, ts: number, guid: string): string;
export function randStr(length: number): string;
export function base36(value: number): string;
