/**
 * Target-addressed peer delivery on the Host's existing loopback web server.
 *
 * This is deliberately not a pet bridge: that bridge owns one socket and
 * routes to `agents.owner`, so switching the active session changes its target.
 * Here `to` is a session id, lookup is exact, and a missing target is a refusal.
 * Nothing in this module appends a session event directly; the only write path
 * is the live agent's `followup`, which is validated by the Host.
 */
import { userMessage } from './threads.mjs';

export const PEER_PATH = '/dsh-continuity/peer';
export const PEER_BODY_LIMIT = 16 * 1024;
export const PEER_TEXT_LIMIT = 8_000;
export const PEER_FROM_LIMIT = 32;

/** Live main agents, keyed by their session id. Subagents are never targets. */
export class LiveAgents {
  #byId = new Map();

  add(id, agent) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (key.length === 0 || key.length > 200) return false;
    if (!agent || typeof agent !== 'object' || typeof agent.followup !== 'function') return false;
    if (agent.session?.parent) return false;
    this.#byId.set(key, agent);
    return true;
  }

  remove(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (key.length === 0) return;
    this.#byId.delete(key);
  }

  get(id) {
    return typeof id === 'string' ? this.#byId.get(id) ?? null : null;
  }

  get size() {
    return this.#byId.size;
  }
}

/** The one registry shared by the Host route and the continuity-preset tool. */
export const peerAgents = new LiveAgents();

/** Validate the JSON body. `to` is mandatory; there is intentionally no default. */
export function parsePeerPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'body-must-be-a-json-object' };
  }
  const to = typeof payload.to === 'string' ? payload.to.trim() : '';
  if (to.length === 0) return { ok: false, error: 'to-required' };
  if (to.length > 200 || !/^session-[A-Za-z0-9_-]+$/.test(to)) {
    return { ok: false, error: 'to-must-be-a-session-id' };
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text.length === 0) return { ok: false, error: 'text-required' };
  if (text.length > PEER_TEXT_LIMIT) return { ok: false, error: 'text-too-long' };
  const rawFrom = typeof payload.from === 'string' ? payload.from : '';
  const from = rawFrom.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, PEER_FROM_LIMIT) || 'peer';
  return { ok: true, to, from, text };
}

/** A real user-role message with a fresh id and source.kind, not a raw append. */
export function peerMessage({ from, text }) {
  const message = userMessage(`[${from}] ${text}`);
  message.source = { ...message.source, peer: true, peerFrom: String(from ?? '') };
  return message;
}

function isLoopback(address) {
  const value = typeof address === 'string' ? address : '';
  return /^(?:::1|::ffff:127\.|127\.)/i.test(value);
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** HTTP handler shared by the Host route and the tests. */
export async function handlePeerRequest(req, res, { agents, log = console } = {}) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  if (!isLoopback(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'loopback-only' });
    return;
  }
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > PEER_BODY_LIMIT) {
        sendJson(res, 413, { ok: false, error: 'body-too-large' });
        return;
      }
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'body-read-failed' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid-json' });
    return;
  }
  const parsed = parsePeerPayload(payload);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }
  const target = agents?.get?.(parsed.to) ?? null;
  if (target === null || typeof target.followup !== 'function') {
    sendJson(res, 404, { ok: false, error: 'target-not-live', to: parsed.to });
    return;
  }
  const message = peerMessage(parsed);
  try {
    await target.followup(message);
  } catch (error) {
    log?.warn?.(`[dsh-continuity] peer followup failed: ${error?.message ?? error}`);
    sendJson(res, 502, { ok: false, error: 'followup-failed', message: String(error?.message ?? error) });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    to: parsed.to,
    from: parsed.from,
    queued: 'next-turn',
    id: message.id,
  });
}
