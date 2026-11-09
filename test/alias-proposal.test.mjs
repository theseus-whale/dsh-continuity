import assert from 'node:assert/strict';
import test from 'node:test';
import { AliasProposalState } from '../src/memory/alias-proposal.mjs';

test('new term is silent on first mention and proposed on second', () => {
  const state = new AliasProposalState({ threshold: 2 });
  assert.equal(state.observe({ term: '星港', facets: { activity: '跑团' }, nowTurn: 1 }).action, 'none');
  const second = state.observe({ term: '星港', facets: { activity: '跑团' }, nowTurn: 2 });
  assert.equal(second.action, 'propose');
  assert.match(second.text, /星港/);
  assert.equal(state.observe({ term: '星港', facets: { activity: '跑团' }, nowTurn: 3 }).action, 'none');
});

test('known alias is never proposed', () => {
  const state = new AliasProposalState();
  assert.equal(state.observe({ term: 'TRPG', facets: { activity: '跑团' }, nowTurn: 1 }).action, 'none');
  assert.equal(state.observe({ term: 'TRPG', facets: { activity: '跑团' }, nowTurn: 2 }).action, 'none');
});

test('proposal respects cooldown', () => {
  const state = new AliasProposalState({ threshold: 1, cooldownTurns: 10 });
  const first = state.observe({ term: '星港', facets: { activity: '跑团' }, nowTurn: 1 });
  assert.equal(first.action, 'propose');
  state.observe({ term: '灯塔', facets: { activity: '跑团' }, nowTurn: 2 });
  assert.equal(state.observe({ term: '灯塔', facets: { activity: '跑团' }, nowTurn: 3 }).action, 'none');
});
