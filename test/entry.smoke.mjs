const mod = await import('../src/index.mjs');
const logs = [];
const ctx = { logger: { info: (t) => logs.push(['info', t]), warn: (t) => logs.push(['warn', t]) } };
mod.default.apply(ctx, { enabled: false, policy: {} });
console.log(JSON.stringify(logs, null, 2));
try {
  mod.default.apply(ctx, { enabled: false, policy: { nope: 1 } });
} catch (e) {
  console.log('rejected:', e.message);
}
