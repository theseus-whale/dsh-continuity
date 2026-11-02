import { peerAgents, parsePeerPayload, peerMessage } from './peer.mjs';

/**
 * Preset-scoped peer reply tool. It is the agent-facing wrapper around the same
 * exact-target lookup and `agent.followup` used by the loopback route. It never
 * falls back to the active session and never appends a raw session event.
 */
export function createPeerTool({ agents = peerAgents } = {}) {
  return {
    name: 'peer_message',
    description: [
      'Send one user message to one live DSH session by exact session id.',
      'Use it to reply to a peer or send a direct note; the target must already be live.',
      'It returns queued/next-turn with the delivery id, not the target\'s reply.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'text'],
      properties: {
        to: {
          type: 'string',
          description: 'Exact live session id, e.g. session-<uuid>. Required; there is no active or newest fallback.',
        },
        text: {
          type: 'string',
          description: 'Message body. It is prefixed with [from] before delivery.',
        },
        from: {
          type: 'string',
          description: 'Optional display name used in the [from] prefix. Default: Continuity.',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const parsed = parsePeerPayload({
        ...input,
        from: typeof input.from === 'string' && input.from.trim().length > 0 ? input.from : 'Continuity',
      });
      if (!parsed.ok) throw new Error(`peer_message: ${parsed.error}`);
      const target = agents.get(parsed.to);
      if (target === null || typeof target.followup !== 'function') {
        throw new Error(`peer_message: target-not-live (${parsed.to})`);
      }
      const message = peerMessage(parsed);
      await target.followup(message);
      return JSON.stringify({
        ok: true,
        to: parsed.to,
        from: parsed.from,
        queued: 'next-turn',
        id: message.id,
      });
    },
  };
}
