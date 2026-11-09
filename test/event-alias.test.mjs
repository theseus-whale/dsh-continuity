import assert from 'node:assert/strict';
import test from 'node:test';
import { EventAliasLedger } from '../src/memory/event-alias-ledger.mjs';
import { EventSegmenter } from '../src/memory/event-segmenter.mjs';

const run = { activity: '跑团', topic: '剧情' };
const dev = { activity: '开发', topic: '技术' };

test('event segmenter opens a boundary on facet change', () => {
  const segmenter = new EventSegmenter();
  assert.equal(segmenter.observe({ facets: dev, nowTurn: 1 }).eventId, 0);
  const changed = segmenter.observe({ facets: run, nowTurn: 2 });
  assert.equal(changed.eventId, 1);
  assert.equal(changed.boundary, true);
  assert.equal(segmenter.observe({ facets: run, nowTurn: 3 }).eventId, 1);
});

test('two user mentions in one event do not promote an alias', () => {
  const ledger = new EventAliasLedger();
  assert.equal(ledger.observe({ term: '星港', eventId: 1, target: '跑团', role: 'campaign', nowTurn: 1 }).action, 'none');
  const second = ledger.observe({ term: '星港', eventId: 1, target: '跑团', role: 'campaign', nowTurn: 2 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'need-event-repeat');
});

test('cross-event user use promotes an alias', () => {
  const ledger = new EventAliasLedger();
  ledger.observe({ term: '星港', eventId: 1, target: '跑团', role: 'campaign', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 3, target: '跑团', role: 'campaign', nowTurn: 5 });
  assert.equal(second.action, 'propose');
  assert.match(second.text, /星港/);
});

test('assistant-only mentions never promote', () => {
  const ledger = new EventAliasLedger();
  ledger.observe({ term: '星港', source: 'assistant', eventId: 1, target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', source: 'assistant', eventId: 2, target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'need-user-repeat');
});

test('unstable role blocks promotion', () => {
  const ledger = new EventAliasLedger();
  ledger.observe({ term: '星港', eventId: 1, target: '跑团', role: 'campaign', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 2, target: '跑团', role: 'location', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'role-unstable');
});

test('no target facet becomes an accommodation candidate', () => {
  const ledger = new EventAliasLedger();
  ledger.observe({ term: '潮汐语法', eventId: 1, target: null, nowTurn: 1 });
  const second = ledger.observe({ term: '潮汐语法', eventId: 2, target: null, nowTurn: 3 });
  assert.equal(second.action, 'accommodate');
  assert.match(second.text, /新概念/);
});
