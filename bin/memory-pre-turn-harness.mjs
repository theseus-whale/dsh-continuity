#!/usr/bin/env node
/**
 * Offline pre-turn harness: scripted user/Coo messages through the integration
 * layer. No live session and no writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readEventLog } from '../src/memory/event-log.mjs';
import { PreTurnController } from '../src/memory/pre-turn.mjs';
import { MemoryLoadState } from '../src/memory/load-gate.mjs';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = argOf('--dir');
if (!dir) {
  console.error('usage: node bin/memory-pre-turn-harness.mjs --dir .durable-memory');
  process.exit(2);
}
const records = readEventLog(path.join(dir, 'events.jsonl'));
const dev = { activity: '开发', topic: '技术' };
const run = { activity: '跑团', topic: '剧情' };
const controller = new PreTurnController({
  records,
  gate: new MemoryLoadState({ loadedFacets: dev, loadedAtTurn: 1490 }),
});
const messages = [
  { text: '我们先写文档', role: 'user', facets: dev, eventSlots: { activity: '开发', topic: '技术', location: null }, confidence: 0.9 },
  { text: '我们现在开始跑团吧', role: 'user', facets: run, eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' }, confidence: 0.9 },
  { text: '我推门进灯室', role: 'user', facets: run, eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' }, confidence: 0.9 },
  { text: 'Coo：灯室见', role: 'coo', facets: run, eventSlots: { activity: '跑团', topic: '剧情', location: '钟楼' }, confidence: 0.9 },
  { text: '规则怎么写', role: 'user', facets: dev, eventSlots: { activity: '开发', topic: '规则', location: null }, confidence: 0.9 },
  { text: '上次跑团怎么样了', role: 'user', facets: run, eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' }, confidence: 0.9 },
  { text: '开始跑团', role: 'assistant', facets: run, eventSlots: { activity: '跑团', topic: '剧情', location: '灯室' }, confidence: 0.9 },
  { text: '继续', role: 'user', facets: run, eventSlots: { location: 42 }, confidence: 0.9 },
];
const rows = messages.map((message, index) => {
  const result = controller.step({ ...message, nowTurn: 1500 + index });
  return {
    text: message.text,
    role: message.role,
    action: result.action,
    reason: result.reason,
    boundaryScore: result.boundaryScore,
    eventId: result.eventId,
    eventError: result.eventError ?? null,
    candidateTurn: result.candidateTurn,
    segmentTurns: result.segment?.turns ?? 0,
    telemetry: result.telemetry,
  };
});
const summary = {
  messages: rows.length,
  loads: rows.filter((row) => row.action === 'load').length,
  hints: rows.filter((row) => row.action === 'hint').length,
  none: rows.filter((row) => row.action === 'none').length,
  eventErrors: rows.filter((row) => row.eventError !== null).length,
};
const output = { dir, summary, rows };
fs.writeFileSync(path.join(dir, 'PRE-TURN-HARNESS.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
