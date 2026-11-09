/**
 * Headless smoke test for the Client half.
 *
 * There is no browser control in this environment, so this does not render
 * CSS or verify pixels. It does execute the real module, its slot
 * registrations, the locale registration, the sidebar icon, and the full panel
 * element tree against the live Host snapshot (or an embedded fallback). It
 * catches reference errors, bad component types, and unknown locale keys.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const STATE_URL = `${process.env.DSH_WEB_URL ?? 'http://127.0.0.1:5437'}/dsh-continuity/state.json`;

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      captured = options;
    },
  },
};

const dictionaries = new Map();
const registry = new Map();
let snapshot = null;

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } };
  },
  useMemo(factory) {
    return factory();
  },
  useReducer(initial) {
    return [initial, () => {}];
  },
  useState(initial) {
    return [snapshot ?? initial, () => {}];
  },
  useEffect() {},
};

const locale = {
  register(_ns, id, dict) {
    dictionaries.set(id, dict);
    return () => {};
  },
  bind() {
    return (key) => dictionaries.get('zh')?.[key] ?? dictionaries.get('en')?.[key] ?? key;
  },
  subscribe() {
    return () => {};
  },
};

const ctx = {
  locale,
  effect(execute) {
    execute();
  },
  slots: {
    inject(name, callback) {
      callback();
    },
    register(options, component) {
      registry.set(`${options.name}:${options.id ?? options.key}`, { options, component });
      return () => {};
    },
  },
};

await import(`${pathToFileURL(clientPath).href}?smoke=${Date.now()}`);
if (captured === null) throw new Error('client did not call __ModuleLoader__.load');
const plugin = captured.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`unexpected require(${name})`);
});
plugin.apply(ctx);

const iconEntry = registry.get('sidebar.panellist:continuity');
const panelEntry = registry.get('main:continuity');
if (iconEntry === undefined) throw new Error('sidebar.panellist registration missing');
if (panelEntry === undefined) throw new Error('main registration missing');
if (typeof iconEntry.options.label !== 'function') throw new Error('sidebar label is not a thunk');
if (iconEntry.options.label() !== '连续性') throw new Error(`unexpected label: ${iconEntry.options.label()}`);

const icon = iconEntry.component({ size: 18, active: true });
if (icon?.type !== 'svg') throw new Error('sidebar icon is not an svg element');

let payload;
try {
  const response = await fetch(STATE_URL, { signal: AbortSignal.timeout(4000) });
  payload = await response.json();
} catch {
  payload = {
    plugin: { name: 'dsh-continuity', version: '0.1.0' },
    generatedAt: new Date().toISOString(),
    panel: { path: '/dsh-continuity/state.json' },
    engine: null,
    passes: [],
    presets: [],
    provenance: {
      convention: 'Blocks tagged [gist] are reconstructions, not verbatim memory.',
      sample: '[gist · log:session-…#seq=120-154 · 34 messages · original retrievable]',
    },
    projection: null,
    facts: [],
  };
}
payload.passes = [{
  at: Date.now(),
  start: 120,
  end: 154,
  count: 34,
  tokens: 5000,
  reason: 'setpoint',
}];

snapshot = { status: 'ok', data: payload, error: null };
const tree = panelEntry.component({});

function collect(node, text) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, text);
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collect(node.type(node.props ?? {}), text);
      return;
    }
    collect(node.props?.children, text);
  }
}

const text = [];
collect(tree, text);
const joined = text.join(' ');
for (const expected of ['连续性', 'seq 120–154', 'setpoint', '出处也是策略的一部分', payload.provenance.sample]) {
  if (!joined.includes(expected)) throw new Error(`panel output is missing: ${expected}`);
}

console.log(`client smoke ok: ${registry.size} slots, panel text ${joined.length} chars, label ${iconEntry.options.label()}`);
