import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerTool } from '../src/peer-tool.mjs';
import { PEER_PATH } from '../src/peer.mjs';

test('peer tool and route are restored', () => {
  const tool = createPeerTool({ agents: new Map() });
  assert.equal(tool.name, 'peer_message');
  assert.equal(tool.parameters.required.includes('to'), true);
  assert.equal(PEER_PATH, '/dsh-continuity/peer');
});
