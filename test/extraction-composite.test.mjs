import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompositeProvider } from '../src/memory/extraction-composite.mjs';

const ner = {
  mode: 'fake',
  async extract() {
    return { ok: true, source: 'fake', data: { slots: { characters: ['宁'], location: '灯室', objects: [] }, entities: [{ text: '宁' }] } };
  },
};

test('composite combines NER, SRL, coref, EL', async () => {
  const provider = createCompositeProvider({
    ner,
    srl: {
      mode: 'fake',
      async extract() {
        return { ok: true, data: { verb: '进', words: ['宁', '进', '灯室', '拿', '钥匙'], tags: ['B-ARG0', 'B-V', 'B-ARGM-LOC', 'B-ARG1', 'I-ARG1'] } };
      },
    },
    coref: {
      mode: 'fake',
      async extract() {
        return { ok: true, data: { clusters: [{ clusterId: 'coref:1', canonical: '宁', mentions: [{ text: '宁' }] }] } };
      },
    },
    el: {
      mode: 'fake',
      async extract({ candidates }) {
        assert.ok(candidates.includes('宁'));
        return { ok: true, data: { links: [{ text: '宁', entityId: 'p:1', score: 0.9 }] } };
      },
    },
  });
  const result = await provider.extract({ text: '宁进灯室拿钥匙' });
  assert.equal(result.ok, true);
  assert.equal(result.data.slots.location, '灯室');
  assert.deepEqual(result.data.slots.characters, ['宁']);
  assert.equal(result.data.slots.goal, null);
  assert.equal(result.data.corefClusters.length, 1);
  assert.equal(result.data.entityLinks[0].text, '宁');
  assert.equal(result.data.partial.srl.ok, true);
});

test('optional SRL failure keeps NER slots', async () => {
  const provider = createCompositeProvider({
    ner,
    srl: { mode: 'fake', async extract() { return { ok: false, reason: 'boom' }; } },
  });
  const result = await provider.extract({ text: '宁进灯室' });
  assert.equal(result.ok, true);
  assert.equal(result.data.slots.location, '灯室');
  assert.equal(result.data.partial.srl.ok, false);
});

test('composite close closes child providers', () => {
  const closed = [];
  const make = (name) => ({ async extract() { return { ok: true, data: {} }; }, close() { closed.push(name); } });
  const provider = createCompositeProvider({ ner: make('ner'), coref: make('coref'), srl: make('srl'), el: make('el') });
  provider.close();
  assert.deepEqual(closed, ['ner', 'coref', 'srl', 'el']);
});

test('NER failure fails closed', async () => {
  const provider = createCompositeProvider({ ner: { async extract() { return { ok: false, reason: 'ner-down' }; } } });
  const result = await provider.extract({ text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ner-down');
});
