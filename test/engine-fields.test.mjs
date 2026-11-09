import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(new URL('../src/engine.mjs', import.meta.url), 'utf8');

test('引擎里所有 this.X 集合/映射字段都有初始化', () => {
  // 收集被当作容器使用（.get/.set/.has/.add）的字段名
  const used = new Set();
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\.(?:get|set|has|add)\(/g)) used.add(m[1]);
  // 收集有赋值的字段名
  const assigned = new Set();
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)) assigned.add(m[1]);
  const BASE_FIELDS = new Set(['ctx']); // 基类提供的字段
  const missing = [...used].filter((name) => !assigned.has(name) && !BASE_FIELDS.has(name));
  assert.deepEqual(missing, [], '这些字段被当容器用了但从未初始化：' + missing.join(', '));
});
