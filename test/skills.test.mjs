import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-'));
mkdirSync(join(dir, 'skills'), { recursive: true });
writeFileSync(join(dir, 'skills', 'index.json'), JSON.stringify({
  skills: [
    { name: 'a', file: 'a.md', aliases: ['A'], threads: ['T1'] },
    { name: 'b', file: 'b.md', aliases: ['B'], threads: ['T2'] },
  ],
  byKeyword: { A: 'a.md', B: 'b.md' },
}));
writeFileSync(join(dir, 'skills', 'a.md'), '---\nname: a\n---\n\nbody-a');
writeFileSync(join(dir, 'skills', 'b.md'), '---\nname: b\n---\n\nbody-b');
process.env.DSH_CONTINUITY_HOME = dir;

const mod = await import('../src/skills.mjs');

test('matches by thread id', async () => {
  mod.clearSkillsCache();
  const idx = await mod.readSkillsIndex();
  const hit = mod.skillsForThreads(idx, ['T1']);
  assert.deepEqual(hit.map((s) => s.name), ['a']);
});

test('no match for unknown thread', async () => {
  const idx = await mod.readSkillsIndex();
  assert.equal(mod.skillsForThreads(idx, ['T9']).length, 0);
});

test('block strips frontmatter and joins bodies', async () => {
  mod.clearSkillsCache();
  const idx = await mod.readSkillsIndex();
  const block = await mod.buildSkillsBlock(mod.skillsForThreads(idx, ['T1', 'T2']));
  assert.ok(block.includes('body-a'));
  assert.ok(block.includes('body-b'));
  assert.ok(!block.includes('name: a'));
});

test('missing index yields empty', async () => {
  process.env.DSH_CONTINUITY_HOME = join(dir, 'nope');
  mod.clearSkillsCache();
  const idx = await mod.readSkillsIndex();
  assert.equal(idx.skills.length, 0);
  process.env.DSH_CONTINUITY_HOME = dir;
  rmSync(dir, { recursive: true, force: true });
});

test('技能文件改动后无需重启即生效（缓存带 mtime 校验）', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-skills-fresh-'));
  mkdirSync(join(fresh, 'skills'), { recursive: true });
  writeFileSync(join(fresh, 'skills', 'index.json'), JSON.stringify({
    skills: [{ name: 'x', file: 'x.md', threads: ['T1'] }],
    byKeyword: {},
  }));
  writeFileSync(join(fresh, 'skills', 'x.md'), '---\nname: x\n---\n\nbody-x');
  process.env.DSH_CONTINUITY_HOME = fresh;
  mod.clearSkillsCache();
  const idx = await mod.readSkillsIndex();
  const first = await mod.buildSkillsBlock(mod.skillsForThreads(idx, ['T1']));
  assert.ok(first.includes('body-x'), first);
  writeFileSync(join(fresh, 'skills', 'x.md'), '---\nname: x\n---\n\nbody-x-v2');
  const second = await mod.buildSkillsBlock(mod.skillsForThreads(idx, ['T1']));
  assert.ok(second.includes('body-x-v2'), second);
  process.env.DSH_CONTINUITY_HOME = dir;
});

test('BOM 前缀也能剥掉 frontmatter', async () => {
  const { stripFrontmatter } = await import('../src/skills.mjs');
  const body = stripFrontmatter('\uFEFF---\nname: b\n---\n\nbody-b');
  if (body.includes('name: b')) throw new Error('frontmatter leaked');
  if (!body.includes('body-b')) throw new Error('body missing');
  const plain = stripFrontmatter('\uFEFFno frontmatter');
  if (plain !== 'no frontmatter') throw new Error('BOM not stripped');
});
