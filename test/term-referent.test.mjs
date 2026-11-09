import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTerms } from '../src/memory/term-extractor.mjs';
import { ReferentLedger } from '../src/memory/referent-ledger.mjs';

test('extracts definition, quote and rule-name terms', () => {
  const terms = extractTerms('我们开个新团，叫《星港》。星港的规则是掷骰。');
  assert.ok(terms.some((item) => item.term === '星港' && item.kind === 'definition'));
  assert.ok(terms.some((item) => item.term === '星港'));
});

test('rejects stopword-like candidates', () => {
  const terms = extractTerms('这个东西叫什么？最近不知道为什么。');
  assert.equal(terms.some((item) => item.term === '什么'), false);
  assert.equal(terms.some((item) => item.term === '最近'), false);
});

test('same term with stable referent across events proposes an alias', () => {
  const ledger = new ReferentLedger();
  ledger.observe({ term: '星港', eventId: 1, referent: 'run:星港', role: 'campaign', target: '跑团', kind: 'definition', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 3, referent: 'run:星港', role: 'campaign', target: '跑团', nowTurn: 5 });
  assert.equal(second.action, 'propose');
  assert.equal(second.referent, 'run:星港');
  assert.match(second.text, /星港/);
});

test('same term with different referents does not become an alias', () => {
  const ledger = new ReferentLedger();
  ledger.observe({ term: '星港', eventId: 1, referent: 'campaign:1', role: 'campaign', target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 2, referent: 'place:1', role: 'location', target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'role-unstable');
});

test('assistant-only mentions never promote', () => {
  const ledger = new ReferentLedger();
  ledger.observe({ term: '星港', source: 'assistant', eventId: 1, referent: 'run:星港', target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', source: 'assistant', eventId: 2, referent: 'run:星港', target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'need-user-repeat');
});

test('no referent means no alias', () => {
  const ledger = new ReferentLedger();
  ledger.observe({ term: '星港', eventId: 1, target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 2, target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'no-referent');
});

test('NIL referent is not promoted', () => {
  const ledger = new ReferentLedger();
  ledger.observe({ term: '星港', eventId: 1, referent: 'NIL', target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 2, referent: 'NIL', target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'nil-referent');
});

test('confirmation can be required before promotion', () => {
  const ledger = new ReferentLedger({ requireConfirmation: true });
  ledger.observe({ term: '星港', eventId: 1, referent: 'run:星港', target: '跑团', nowTurn: 1 });
  const second = ledger.observe({ term: '星港', eventId: 2, referent: 'run:星港', target: '跑团', nowTurn: 3 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'unconfirmed');
  const third = ledger.observe({ term: '星港', eventId: 3, referent: 'run:星港', target: '跑团', nowTurn: 5, confirmed: true });
  assert.equal(third.action, 'propose');
});
