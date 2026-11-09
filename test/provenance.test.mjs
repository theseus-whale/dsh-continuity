import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_CONVENTION, gistHeader, renderGistBlock, annotateSummary } from '../src/provenance.mjs';

test('header from a pointer', () => {
  assert.equal(
    gistHeader({ pointer: 'log:main#seq=120-154', count: 34 }),
    '[gist · log:main#seq=120-154 · 34 messages · original retrievable via session_log]',
  );
});

test('header from a session id and seq range', () => {
  assert.equal(
    gistHeader({ sessionId: 'main', startSeq: 120, endSeq: 154 }),
    '[gist · log:main#seq=120-154 · original retrievable via session_log]',
  );
});

test('header refuses to be untraceable', () => {
  assert.throws(() => gistHeader({ count: 3 }), /pointer or a session id/);
});

test('block keeps the fixed order and omits empty sections', () => {
  const text = renderGistBlock({
    header: gistHeader({ pointer: 'log:main#seq=1-9' }),
    gist: ['decided to keep the tail'],
    verbatim: ['"don\'t change my config"'],
    uncertain: ['whether C was agreed'],
  });
  assert.match(text, /^\[gist · log:main#seq=1-9/);
  assert.ok(text.indexOf('[verbatim]') < text.indexOf('- [gist]'));
  assert.ok(text.indexOf('- [gist]') < text.indexOf('- [uncertain]'));
  assert.ok(!text.includes('[open]'));
});

test('a block without a gist header is rejected', () => {
  assert.throws(() => renderGistBlock({ header: 'summary' }), /header from gistHeader/);
});

test('annotateSummary prepends to the first text block and clones', () => {
  const source = [{ type: 'text', text: 'body' }, { type: 'image', text: undefined }];
  const out = annotateSummary(source, '[gist · x · original retrievable]');
  assert.equal(out[0].text, '[gist · x · original retrievable]\nbody');
  assert.equal(source[0].text, 'body');
  assert.notEqual(out[0], source[0]);
});

test('annotateSummary inserts a text block when none exists', () => {
  const out = annotateSummary([{ type: 'image' }], '[gist · x]');
  assert.equal(out[0].type, 'text');
  assert.equal(out[1].type, 'image');
});

test('the standing convention names the tag, the tool, and the fallback', () => {
  assert.match(SYSTEM_CONVENTION, /\[gist\]/);
  assert.match(SYSTEM_CONVENTION, /session_log/);
  assert.match(SYSTEM_CONVENTION, /index/);
  assert.match(SYSTEM_CONVENTION, /grep/);
  assert.match(SYSTEM_CONVENTION, /get/);
  assert.match(SYSTEM_CONVENTION, /older gist pointer/);
  assert.match(SYSTEM_CONVENTION, /only remember the gist/);
  assert.match(SYSTEM_CONVENTION, /2–3 fetches/);
});
