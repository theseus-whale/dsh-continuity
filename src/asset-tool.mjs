import { join } from 'node:path';
import { assetMarker, readAssetIndex, writeAsset, writeChildAsset } from './assets.mjs';
import { eventContentBlocks } from './tool-preview.mjs';

export const name = 'dsh-continuity/asset-tool';

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'list'],
      description: 'get = one parent-session asset; list = recent parent-session assets.',
    },
    seq: {
      type: 'integer',
      description: 'get: the original event seq.',
    },
    path: {
      type: 'string',
      description: 'get: a registered relative path, e.g. assets/parent/image-42-abcd1234.png.',
    },
    limit: {
      type: 'integer',
      description: 'list: maximum rows (default 20, max 100).',
    },
  },
  required: ['action'],
};

const CHILD_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'list'],
      description: 'get = one child-session/PTC artifact; list = recent child artifacts.',
    },
    childSessionId: {
      type: 'string',
      description: 'Child session id, as shown in an [asset-child ...] marker.',
    },
    runId: {
      type: 'string',
      description: 'Optional PTC run id.',
    },
    seq: {
      type: 'integer',
      description: 'get: the child event seq.',
    },
    path: {
      type: 'string',
      description: 'get: a registered relative path, e.g. assets/ptc/run/child/image-...png.',
    },
    limit: {
      type: 'integer',
      description: 'list: maximum rows (default 20, max 100).',
    },
  },
  required: ['action'],
};

function defaultHome() {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'continuity');
}

function formatRow(row) {
  return `${assetMarker(row)} sha256=${row.sha256 ?? '?'} name=${row.name ?? '?'}`;
}

function formatChildRow(row) {
  return `${assetMarker(row, 'child')} sha256=${row.sha256 ?? '?'} name=${row.name ?? '?'}`;
}

export function createSessionAssetTool({ home = defaultHome(), sessionQuery = null } = {}) {
  return {
    name: 'session_asset',
    description: 'Retrieve a folded non-text payload from the current session assets. '
      + 'Use after session_log shows an [asset-parent ...] marker. '
      + 'The payload is outside the context; this returns its registered path and metadata, not the bytes.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = input.action;
      if (action !== 'get' && action !== 'list') {
        throw new Error('session_asset: action must be "get" or "list".');
      }
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (sessionId === undefined || sessionId === null) {
        throw new Error('session_asset: no current session id.');
      }
      const rows = (await readAssetIndex({ home, sessionId: String(sessionId) }))
        .filter((row) => row.owner === 'parent');
      if (action === 'list') {
        const limit = Math.min(100, Math.max(1, Number.isInteger(input.limit) ? input.limit : 20));
        const shown = rows.slice(-limit).reverse();
        return [
          `session_asset list · session=${sessionId} · assets=${rows.length}`,
          ...shown.map(formatRow),
        ].join('\n');
      }
      if (input.seq === undefined && input.path === undefined) {
        throw new Error('session_asset get: seq or path is required.');
      }
      const row = input.path !== undefined
        ? rows.find((entry) => entry.path === input.path)
        : rows.find((entry) => Number(entry.seq) === Number(input.seq));
      if (row === undefined && input.path === undefined && input.seq !== undefined
        && typeof sessionQuery?.readSession === 'function') {
        try {
          const snapshot = await sessionQuery.readSession(String(sessionId));
          const event = (Array.isArray(snapshot?.events) ? snapshot.events : [])
            .find((entry) => Number(entry?.seq) === Number(input.seq));
          const recovered = [];
          for (const block of eventContentBlocks(event) ?? []) {
            if (block === null || typeof block !== 'object') continue;
            if (!['image', 'file', 'audio', 'video'].includes(block.type)) continue;
            const written = await writeAsset({
              home,
              sessionId: String(sessionId),
              block,
              seq: input.seq,
            });
            if (written.ok) recovered.push(written.row);
          }
          if (recovered.length > 0) {
            return [
              `session_asset get · session=${sessionId} · recovered from raw seq=${input.seq}`,
              ...recovered.map(formatRow),
              `absolute=${join(home, 'sessions', String(sessionId), recovered[0].path)}`,
            ].join('\n');
          }
        } catch { /* fall through to missing */ }
      }
      if (row === undefined) {
        return `session_asset get · session=${sessionId} · no registered asset for ${input.path ?? `seq=${input.seq}`}`;
      }
      return [
        `session_asset get · session=${sessionId}`,
        formatRow(row),
        `absolute=${join(home, 'sessions', String(sessionId), row.path)}`,
      ].join('\n');
    },
  };
}

export function createChildAssetTool({ home = defaultHome(), sessionQuery = null } = {}) {
  return {
    name: 'child_asset',
    description: 'Retrieve a folded child/PTC artifact from the parent session assets. '
      + 'Use after session_log shows an [asset-child ...] marker. '
      + 'This returns the registered path and metadata, not the bytes.',
    parameters: CHILD_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = input.action;
      if (action !== 'get' && action !== 'list') {
        throw new Error('child_asset: action must be "get" or "list".');
      }
      const parentSessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
      if (parentSessionId === undefined || parentSessionId === null) {
        throw new Error('child_asset: no current parent session id.');
      }
      const rows = (await readAssetIndex({ home, sessionId: String(parentSessionId) }))
        .filter((row) => row.owner === 'child')
        .filter((row) => input.childSessionId === undefined || row.childSessionId === input.childSessionId)
        .filter((row) => input.runId === undefined || row.runId === input.runId);
      if (action === 'list') {
        const limit = Math.min(100, Math.max(1, Number.isInteger(input.limit) ? input.limit : 20));
        const shown = rows.slice(-limit).reverse();
        return [
          `child_asset list · session=${parentSessionId} · assets=${rows.length}`,
          ...shown.map(formatChildRow),
        ].join('\n');
      }
      if (input.seq === undefined && input.path === undefined) {
        throw new Error('child_asset get: seq or path is required.');
      }
      const row = input.path !== undefined
        ? rows.find((entry) => entry.path === input.path)
        : rows.find((entry) => Number(entry.seq) === Number(input.seq));
      if (row === undefined && input.path === undefined
        && input.childSessionId !== undefined && input.seq !== undefined
        && typeof sessionQuery?.readSession === 'function') {
        try {
          const snapshot = await sessionQuery.readSession(input.childSessionId);
          const event = (Array.isArray(snapshot?.events) ? snapshot.events : [])
            .find((entry) => Number(entry?.seq) === Number(input.seq));
          const blocks = event?.data?.message?.content;
          const recovered = [];
          for (const block of Array.isArray(blocks) ? blocks : []) {
            if (block === null || typeof block !== 'object') continue;
            if (!['image', 'file', 'audio', 'video'].includes(block.type)) continue;
            const written = await writeChildAsset({
              home,
              parentSessionId: String(parentSessionId),
              childSessionId: input.childSessionId,
              runId: input.runId ?? 'adhoc',
              block,
              seq: input.seq,
            });
            if (written.ok) recovered.push(written.row);
          }
          if (recovered.length > 0) {
            return [
              `child_asset get · session=${parentSessionId} · recovered from child=${input.childSessionId}`,
              ...recovered.map(formatChildRow),
              `absolute=${join(home, 'sessions', String(parentSessionId), recovered[0].path)}`,
            ].join('\n');
          }
        } catch { /* fall through to the missing message */ }
      }
      if (row === undefined) {
        return `child_asset get · session=${parentSessionId} · no registered child asset for ${input.path ?? `seq=${input.seq}`}`;
      }
      return [
        `child_asset get · session=${parentSessionId}`,
        formatChildRow(row),
        `absolute=${join(home, 'sessions', String(parentSessionId), row.path)}`,
      ].join('\n');
    },
  };
}
