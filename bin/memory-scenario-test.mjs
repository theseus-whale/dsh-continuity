#!/usr/bin/env node
/**
 * Scenario replay: new term, new→old, old→new→old, repeated recall,
 * Coo interjection. Gate is before the turn; alias proposal is after it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { MemoryLoadState, latestCandidate, candidateSegment } from '../src/memory/load-gate.mjs';
import { AliasProposalState } from '../src/memory/alias-proposal.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
if (!dir) {
  console.error('usage: node bin/memory-scenario-test.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const dev = { activity: '开发', topic: '技术' };
const run = { activity: '跑团', topic: '剧情' };

const scenarios = [
  {
    id: 'new-term',
    steps: [
      { text: '我们开个新团，叫星港', facets: run, term: '星港', gate: 'load', alias: 'none' },
      { text: '星港的规则是掷骰', facets: run, term: '星港', gate: 'none', alias: 'propose' },
      { text: '星港继续', facets: run, term: '星港', gate: 'none', alias: 'none' },
    ],
  },
  {
    id: 'new-old-back',
    steps: [
      { text: '我们开个新团，叫星港', facets: run, term: '星港', gate: 'load', alias: 'none' },
      { text: '星港里有一扇门', facets: run, term: '星港', gate: 'none', alias: 'propose' },
      { text: '上次跑团怎么样了', facets: run, gate: 'load', alias: 'none' },
      { text: '回到星港', facets: run, term: '星港', gate: 'none', alias: 'none' },
    ],
  },
  {
    id: 'old-new-old',
    steps: [
      { text: '规则怎么写', facets: dev, gate: 'none', alias: 'none' },
      { text: '开始跑团', facets: run, gate: 'load', alias: 'none' },
      { text: '星港的规则是掷骰', facets: run, term: '星港', gate: 'none', alias: 'none' },
      { text: '星港继续', facets: run, term: '星港', gate: 'none', alias: 'propose' },
      { text: '上次规则写哪了', facets: dev, gate: 'load', alias: 'none' },
    ],
  },
  {
    id: 'repeat-recall',
    steps: [
      { text: '上次跑团怎么样了', facets: run, gate: 'load', alias: 'none' },
      { text: '上次跑团后来呢', facets: run, gate: 'load', alias: 'none' },
      { text: '继续跑团', facets: run, gate: 'none', alias: 'none' },
    ],
  },
  {
    id: 'coo-interject',
    steps: [
      { text: 'Coo：来一局', facets: run, gate: 'load', alias: 'none', role: 'coo' },
      { text: 'Coo：灯室见', facets: run, gate: 'none', alias: 'none', role: 'coo' },
      { text: '我推门进去', facets: run, gate: 'none', alias: 'none' },
    ],
  },
  {
    id: 'known-alias',
    steps: [
      { text: 'TRPG 开一把', facets: run, term: 'TRPG', gate: 'load', alias: 'none' },
    ],
  },
];

const output = [];
for (const scenario of scenarios) {
  const loadState = new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 0 });
  const aliasState = new AliasProposalState();
  const events = [];
  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index];
    const nowTurn = 100 + index;
    const candidate = latestCandidate(records, 'activity', step.facets.activity);
    const segment = candidateSegment(records, candidate);
    const gate = loadState.decide({
      text: step.text,
      currentFacets: step.facets,
      confidence: 0.9,
      nowTurn,
      hasCandidate: candidate !== null,
      candidate,
      role: step.role ?? 'user',
    });
    if (gate.action === 'load') {
      loadState.recordLoad({ facets: step.facets, seq: segment?.seqStart ?? null, nowTurn, reason: gate.reason });
    }
    const alias = aliasState.observe({ term: step.term, facets: step.facets, nowTurn });
    events.push({
      text: step.text,
      gate: gate.action,
      gateReason: gate.reason,
      expectedGate: step.gate,
      alias: alias.action,
      aliasReason: alias.reason,
      expectedAlias: step.alias,
      aliasText: alias.text ?? null,
      candidateTurn: candidate?.turn ?? null,
      segmentTurns: segment?.turns ?? 0,
      position: { gate: 'before-response', alias: 'after-turn' },
    });
  }
  const gatePass = events.filter((event) => event.gate === event.expectedGate).length;
  const aliasPass = events.filter((event) => event.alias === event.expectedAlias).length;
  output.push({
    id: scenario.id,
    steps: events.length,
    gatePass,
    aliasPass,
    pass: gatePass === events.length && aliasPass === events.length,
    events,
  });
}
const summary = {
  scenarios: output.length,
  steps: output.reduce((sum, item) => sum + item.steps, 0),
  passScenarios: output.filter((item) => item.pass).length,
  failedScenarios: output.filter((item) => !item.pass).map((item) => item.id),
  missedAliasProposals: output.flatMap((item) => item.events.filter((event) => event.expectedAlias === 'propose' && event.alias !== 'propose')).length,
  extraAliasProposals: output.flatMap((item) => item.events.filter((event) => event.expectedAlias !== 'propose' && event.alias === 'propose')).length,
};
const result = { dir, summary, output };
fs.writeFileSync(path.join(dir, 'SCENARIO-TEST.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const scenario of output) {
  if (!scenario.pass) {
    console.log('FAIL', scenario.id);
    for (const event of scenario.events) {
      if (event.gate !== event.expectedGate || event.alias !== event.expectedAlias) {
        console.log(' ', event.text, 'gate', event.gate, 'expected', event.expectedGate, 'alias', event.alias, 'expected', event.expectedAlias);
      }
    }
  }
}
