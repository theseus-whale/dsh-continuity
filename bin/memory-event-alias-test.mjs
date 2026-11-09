#!/usr/bin/env node
/**
 * Event-bound alias scenarios: same-event repeat, cross-event repeat,
 * assistant-only, role change, accommodation.
 */
import { EventSegmenter } from '../src/memory/event-segmenter.mjs';
import { EventAliasLedger } from '../src/memory/event-alias-ledger.mjs';

const run = { activity: '跑团', topic: '剧情' };
const dev = { activity: '开发', topic: '技术' };

const scenarios = [
  {
    id: 'same-event-vs-cross-event',
    steps: [
      { text: '我们开个新团，叫星港', facets: run, term: '星港', role: 'campaign', target: '跑团', expected: 'none' },
      { text: '星港的规则是掷骰', facets: run, term: '星港', role: 'campaign', target: '跑团', expected: 'none' },
      { text: '先写文档', facets: dev, expected: 'none' },
      { text: '回到星港', facets: run, term: '星港', role: 'campaign', target: '跑团', expected: 'propose' },
    ],
  },
  {
    id: 'assistant-only',
    steps: [
      { text: '星港开场', facets: run, term: '星港', role: 'campaign', target: '跑团', source: 'assistant', expected: 'none' },
      { text: '星港的钟楼', facets: run, term: '星港', role: 'campaign', target: '跑团', source: 'assistant', expected: 'none' },
      { text: '先写文档', facets: dev, expected: 'none' },
      { text: '星港还在', facets: run, term: '星港', role: 'campaign', target: '跑团', source: 'assistant', expected: 'none' },
    ],
  },
  {
    id: 'role-change',
    steps: [
      { text: '新团叫星港', facets: run, term: '星港', role: 'campaign', target: '跑团', expected: 'none' },
      { text: '先写文档', facets: dev, expected: 'none' },
      { text: '星港的灯亮了', facets: run, term: '星港', role: 'location', target: '跑团', expected: 'none' },
    ],
  },
  {
    id: 'accommodation',
    steps: [
      { text: '新规则叫潮汐语法', facets: dev, term: '潮汐语法', role: 'rule', target: null, expected: 'none' },
      { text: '开始跑团', facets: run, expected: 'none' },
      { text: '潮汐语法还在', facets: dev, term: '潮汐语法', role: 'rule', target: null, expected: 'accommodate' },
    ],
  },
];

const output = [];
for (const scenario of scenarios) {
  const segmenter = new EventSegmenter();
  const ledger = new EventAliasLedger();
  const events = [];
  scenario.steps.forEach((step, index) => {
    const nowTurn = index + 1;
    const segment = segmenter.observe({ facets: step.facets, nowTurn });
    const alias = step.term === undefined
      ? { action: 'none', reason: 'no-term' }
      : ledger.observe({
        term: step.term,
        source: step.source ?? 'user',
        eventId: segment.eventId,
        role: step.role,
        target: step.target,
        nowTurn,
      });
    events.push({
      text: step.text,
      eventId: segment.eventId,
      boundary: segment.boundary,
      alias: alias.action,
      aliasReason: alias.reason,
      expected: step.expected,
      pass: alias.action === step.expected,
      textHint: alias.text ?? null,
    });
  });
  output.push({
    id: scenario.id,
    pass: events.every((event) => event.pass),
    events,
  });
}
const summary = {
  scenarios: output.length,
  pass: output.filter((item) => item.pass).length,
  failures: output.filter((item) => !item.pass).map((item) => item.id),
};
console.log(JSON.stringify({ summary, output }, null, 2));
