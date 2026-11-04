import { join } from 'node:path';
import { assetMarker } from './assets.mjs';
import { handoffText, writeHandoff } from './handoff.mjs';

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    childSessionId: { type: 'string', description: 'Child/PTC session id.' },
    runId: { type: 'string', description: 'PTC workflow run id.' },
    summary: { type: 'string', description: 'Bounded task result for the parent; do not truncate decisions.' },
    status: { type: 'string', description: 'Optional status, default ok.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Why the child chose this result.' },
    open: { type: 'array', items: { type: 'string' }, description: 'Unfinished work.' },
    artifacts: { type: 'array', items: { type: 'string' }, description: 'Relative artifact paths.' },
    sourceSeqs: { type: 'array', items: { type: 'integer' }, description: 'Child event seqs worth retrieving.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['childSessionId', 'runId', 'summary'],
};

function defaultHome() {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
}

export function createHandoffTool({ home = defaultHome() } = {}) {
  return {
    name: 'ptc_handoff',
    description: 'Register a PTC child result as a parent-visible child artifact. '
      + 'Stores the full envelope under assets/ptc and returns a marker; use child_asset to retrieve it.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const parentSessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (parentSessionId === undefined || parentSessionId === null) {
        throw new Error('ptc_handoff: no current parent session id');
      }
      const result = await writeHandoff({ home, parentSessionId: String(parentSessionId), envelope: input });
      return [
        handoffText(result.envelope),
        assetMarker(result.written.row, 'child'),
      ].join('\n');
    },
  };
}
