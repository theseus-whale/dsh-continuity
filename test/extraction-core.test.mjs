import assert from 'node:assert/strict';
import test from 'node:test';
import { routeLanguage } from '../src/memory/language-router.mjs';
import { createExtractionCore, mapEntitiesToSlots } from '../src/memory/extraction-core.mjs';

test('routes zh, en and mixed text', () => {
  assert.equal(routeLanguage('我推门进灯室').language, 'zh');
  assert.equal(routeLanguage('I open the door').language, 'en');
  assert.equal(routeLanguage('用 SVG 画 avatar.png').language, 'mixed');
  assert.equal(routeLanguage('12345').language, 'unknown');
});

test('maps entities to event slots', () => {
  const slots = mapEntitiesToSlots([
    { text: '宁', label: 'PERSON' },
    { text: '灯室', label: 'LOC' },
    { text: '钥匙', label: 'OBJECT' },
  ]);
  assert.deepEqual(slots.characters, ['宁']);
  assert.equal(slots.location, '灯室');
  assert.deepEqual(slots.objects, ['钥匙']);
});

test('maps Chinese model labels to event slots', () => {
  const slots = mapEntitiesToSlots([
    { text: '彭小军', label: 'name' },
    { text: '台湾', label: 'address' },
    { text: '香港大学', label: 'organization' },
    { text: '暗黑破坏神', label: 'game' },
  ]);
  assert.deepEqual(slots.characters, ['彭小军']);
  assert.equal(slots.location, '台湾');
  assert.ok(slots.objects.includes('香港大学'));
  assert.ok(slots.objects.includes('暗黑破坏神'));
});

test('extraction core routes to provider and validates slots', () => {
  const core = createExtractionCore({
    providers: {
      zh: () => ({ entities: [{ text: '灯室', label: 'LOC', start: 3, end: 5 }] }),
      en: () => ({ entities: [{ text: 'London', label: 'GPE' }] }),
      mixed: () => ({ entities: [{ text: 'SVG', label: 'MISC' }] }),
    },
  });
  const zh = core.extract('我推门进灯室');
  assert.equal(zh.ok, true);
  assert.equal(zh.language, 'zh');
  assert.equal(zh.slots.location, '灯室');
  const en = core.extract('I am in London');
  assert.equal(en.language, 'en');
  assert.equal(en.slots.location, 'London');
});

test('invalid provider output does not mutate slots', () => {
  const core = createExtractionCore({
    providers: { zh: () => ({ slots: { location: 42 } }) },
  });
  const result = core.extract('我推门进灯室');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-slots');
  assert.equal(result.slots, null);
});

test('missing provider and provider errors fail closed', () => {
  const noProvider = createExtractionCore();
  assert.equal(noProvider.extract('hello').reason, 'no-provider');
  const errorCore = createExtractionCore({ providers: { zh: () => { throw new Error('boom'); } } });
  assert.equal(errorCore.extract('你好').reason, 'provider-error');
});
