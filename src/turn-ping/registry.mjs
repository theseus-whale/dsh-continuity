let activeHost = null;

export function setTurnPingHost(host) {
  activeHost = host;
  return host;
}

export function getTurnPingHost() {
  return activeHost;
}

export async function turnPingOnFold(args) {
  if (!activeHost) return { enabled: false, writes: 0, vectors: 0, reason: 'no-host' };
  return activeHost.onFold(args);
}

export async function turnPingBeforeAnswer(args) {
  if (!activeHost) return { enabled: false, ping: null, H: 0, reason: 'no-host' };
  return activeHost.beforeAnswer(args);
}
