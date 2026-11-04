/**
 * dsh-continuity — Web Client half.
 *
 * Registers the left-sidebar entry (`sidebar.panellist`) and the main panel it
 * opens (`main`, keyed by the same id). Visible text is registered through the
 * Client locale service; colors and surfaces come from `--dsw-alias-*` tokens.
 * The data comes from the Host route registered by `src/index.mjs`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-continuity',
  factory(require) {
    // 宿主没给 react（或加载器变了）时安静退出：宁可没有 UI，也不能让 renderer 起不来。
    let React = null;
    try { React = require('react'); } catch (error) {
      try { console.warn('[dsh-continuity] 没有 react，客户端禁用：' + String(error?.message ?? error)); } catch { /* ignore */ }
      return { inject: [], apply() { /* disabled */ } };
    }
    if (React === null || typeof React.createElement !== 'function') {
      return { inject: [], apply() { /* disabled */ } };
    }
    const h = React.createElement;
    const NS = 'dsh-continuity';
    const STATE_URL = '/dsh-continuity/state.json';
    const TAGS_URL = '/dsh-continuity/tags.json';
const BC_URL = '/dsh-continuity/bc.json';
const FACETS_URL = '/dsh-continuity/facets.json';
    const TAGS_TAB_ID = 'continuity-tags';
    const TAGS_TAB_KIND = 'continuityTags';

    const EN = {
      'panel.eyebrow': 'DSH CONTINUITY',
      'panel.title': 'Continuity',
      'tags.title': 'Tags',
      'panel.subtitle': 'Band-controlled compaction with labeled memory. Keep a verbatim recent window, remove a small oldest slice per pass, and tag every summary as a gist with a pointer to its original.',
      'status.engine': 'Engine mounted',
      'status.inert': 'Engine not mounted',
      'status.host': 'Host {version}',
      'status.updated': 'Updated {time}',
      'band.title': 'Band controller',
      'band.hint': 'Measure → plan → the oldest balanced range. One small pass per step, never into the protected tail.',
      'band.setpoint': 'setpoint',
      'band.high': 'high',
      'band.low': 'low',
      'band.emergency': 'emergency',
      'band.protect': 'protect',
      'band.max': 'max / pass',
      'band.min': 'min action',
      'projection.title': 'Config-only projection',
      'projection.hint': 'Computed from the live model route. The shipped backend triggers at min(0.92·W, W − O − headroom) and keeps retainRatio × (W − O) verbatim.',
      'projection.context': 'context window',
      'projection.reserved': 'reserved output',
      'projection.message': 'message budget',
      'projection.threshold': 'base threshold',
      'projection.retain': 'base retain',
      'projection.pass': 'base pass',
      'projection.setpoint': 'band setpoint',
      'projection.protect': 'band protect',
      'projection.source': 'source',
      'projection.invalid': 'retain ≥ threshold — this config would be rejected',
      'provenance.title': 'Provenance is part of the policy',
      'provenance.hint': 'A label on the memory itself, not a banner per event.',
      'provenance.convention': 'Standing convention (one system section)',
      'provenance.sample': 'Checkpoint header',
      'passes.title': 'Recent passes',
      'passes.empty': 'No pass recorded yet. Select the Continuity preset for a new session; passes appear here as they happen.',
      'passes.range': 'range',
      'passes.count': 'messages',
      'passes.tokens': 'tokens',
      'passes.reason': 'reason',
      'facts.title': 'Measured at runtime',
      'facts.hint': 'Recorded from the live 0.2.1-rc.3 Host, not from npm types.',
      'try.title': 'Try it',
      'try.one': 'Start a new session and pick the preset "Band (config-only)" to test thresholdRatio 0.92 / retainRatio 0.5 on the shipped backend.',
      'try.two': 'Pick "Continuity" to test the band engine, gist headers, and the standing convention.',
      'try.three': 'Ask about a detail that only exists in a compacted range. Expected: the model cites the [gist] header and says it only remembers the gist.',
      'try.four': 'Existing sessions keep the preset revision they started with; rollback is one preset selection or disabling the bundle.',
      'error.title': 'The state route is not answering',
      'error.body': 'The sidebar entry is registered, but the Host route returned: {message}',
      'error.reload': 'Reload page',
      'footer': 'The seam is policy, not personhood.',
    };

    const ZH = {
      'panel.eyebrow': 'DSH 连续性',
      'panel.title': '连续性',
      'tags.title': '标签',
      'panel.subtitle': '带标签记忆的带宽压缩：保留最近的逐字窗口，每次只移除最旧的一小片，并把每份摘要标成 [gist]，附回原文的指针。',
      'status.engine': '引擎已挂载',
      'status.inert': '引擎未挂载',
      'status.host': '宿主 {version}',
      'status.updated': '更新于 {time}',
      'band.title': '带宽控制器',
      'band.hint': '测量 → 规划 → 最旧且边界平衡的区间。每步只做一小刀，绝不折进受保护的尾部。',
      'band.setpoint': '设定点',
      'band.high': '高水位',
      'band.low': '低水位',
      'band.emergency': '紧急',
      'band.protect': '保护',
      'band.max': '单次上限',
      'band.min': '最小动作',
      'projection.title': '仅配置实验投影',
      'projection.hint': '按当前模型路由计算。自带后端在 min(0.92·W, W − O − headroom) 触发，并保留 retainRatio × (W − O) 的逐字尾部。',
      'projection.context': '上下文窗口',
      'projection.reserved': '输出预留',
      'projection.message': '消息预算',
      'projection.threshold': '基线阈值',
      'projection.retain': '基线保留',
      'projection.pass': '单次压缩量',
      'projection.setpoint': '带宽设定点',
      'projection.protect': '带宽保护',
      'projection.source': '来源',
      'projection.invalid': '保留 ≥ 阈值 —— 该配置会被拒绝',
      'provenance.title': '出处也是策略的一部分',
      'provenance.hint': '标签贴在记忆本身上，而不是每条事件前的横幅。',
      'provenance.convention': '常驻约定（单条系统段）',
      'provenance.sample': '检查点标题',
      'passes.title': '最近压缩',
      'passes.empty': '还没有记录。用「Continuity」预设新建会话，压缩发生后会出现在这里。',
      'passes.range': '区间',
      'passes.count': '消息',
      'passes.tokens': 'tokens',
      'passes.reason': '原因',
      'facts.title': '运行时实测',
      'facts.hint': '来自运行中的 0.2.1-rc.3 宿主，而不是 npm 类型声明。',
      'try.title': '怎么试',
      'try.one': '新建会话并选择「Band（仅配置）」预设，在自带后端上测试 thresholdRatio 0.92 / retainRatio 0.5。',
      'try.two': '选择「Continuity」预设，测试带宽引擎、gist 标题与常驻约定。',
      'try.three': '追问一个只存在于被压缩区间里的细节。预期：模型引用 [gist] 标题并说明只记得概要。',
      'try.four': '已有会话保留它们启动时的预设版本；回滚只需改选预设或停用插件。',
      'error.title': '状态路由没有响应',
      'error.body': '侧栏入口已注册，但宿主路由返回：{message}',
      'error.reload': '刷新页面',
      'footer': '接缝是策略，不是人格。',
    };

    const S = {
      page: {
        height: '100%',
        minHeight: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '28px 32px 56px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      inner: { maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
      eyebrow: {
        fontSize: 11,
        letterSpacing: '0.12em',
        fontWeight: 650,
        color: 'var(--dsw-alias-label-secondary)',
      },
      h1: { margin: '6px 0 0', fontSize: 24, lineHeight: '32px', fontWeight: 650, letterSpacing: '-0.015em' },
      subtitle: { margin: '6px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', maxWidth: 720 },
      badges: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        lineHeight: '20px',
      },
      dot: (color) => ({ width: 6, height: 6, borderRadius: 3, background: color }),
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        padding: '16px 18px',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
      h2: { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 650 },
      hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px 18px', marginTop: 12 },
      kv: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      k: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      v: { fontSize: 13, lineHeight: '18px', overflowWrap: 'anywhere' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: '18px',
        overflowWrap: 'anywhere',
      },
      pre: {
        margin: '10px 0 0',
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      row: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)',
        gap: 12,
        padding: '7px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        lineHeight: '18px',
      },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)' },
      list: { margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' },
      steps: { margin: '10px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, lineHeight: '18px' },
      button: {
        height: 28,
        padding: '0 12px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        cursor: 'pointer',
      },
    };

    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }

    function pct(value) {
      return `${Math.round(Number(value) * 100)}%`;
    }

    function useTranslate(ctx) {
      const t = React.useMemo(() => ctx.locale.bind(NS), [ctx]);
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => ctx.locale.subscribe(bump), [ctx]);
      return t;
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null, error: null });
      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const load = async () => {
          try {
            const response = await fetch(STATE_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data?.error !== undefined && data?.facts === undefined) throw new Error(String(data.error));
            if (alive) setSnapshot({ status: 'ok', data, error: null });
          } catch (error) {
            if (alive) {
              setSnapshot((current) => current.status === 'ok'
                ? current
                : { status: 'error', data: null, error: String(error?.message ?? error) });
            }
          } finally {
            if (alive) timer = setTimeout(load, 5000);
          }
        };
        load();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);
      return snapshot;
    }

    function Badge({ children, tone }) {
      const color = tone === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-idle-primary)';
      return h('span', { style: S.badge }, h('span', { style: S.dot(color) }), children);
    }

    function Card({ title, hint, children }) {
      return h('section', { style: S.card },
        h('div', { style: S.cardHead },
          h('h2', { style: S.h2 }, title),
          hint ? h('p', { style: { ...S.hint, textAlign: 'right' } }, hint) : null),
        children);
    }

    function KV({ label, value, mono }) {
      return h('div', { style: S.kv },
        h('span', { style: S.k }, label),
        h('span', { style: mono ? S.mono : S.v }, value));
    }

    function BandBar({ t, policy }) {
      const segments = [
        { from: 0, to: policy.low, color: 'var(--dsw-alias-bg-layer-2)', opacity: 1 },
        { from: policy.low, to: policy.setpoint, color: 'var(--dsw-alias-state-idle-primary)', opacity: 0.5 },
        { from: policy.setpoint, to: policy.high, color: 'var(--dsw-alias-brand-primary)', opacity: 0.75 },
        { from: policy.high, to: policy.emergency, color: 'var(--dsw-alias-state-warn-primary)', opacity: 0.7 },
        { from: policy.emergency, to: 1, color: 'var(--dsw-alias-state-error-primary)', opacity: 0.7 },
      ];
      return h('div', { style: { marginTop: 14 } },
        h('div', {
          style: {
            display: 'flex',
            height: 20,
            borderRadius: 10,
            overflow: 'hidden',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
        }, ...segments.map((segment, index) => h('span', {
          key: index,
          style: {
            width: `${Math.max(0, segment.to - segment.from) * 100}%`,
            background: segment.color,
            opacity: segment.opacity,
          },
        }))),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, '0'),
          policy.setpoint !== policy.high
            ? h('span', null, `${t('band.setpoint')} ${pct(policy.setpoint)}`)
            : null,
          h('span', null, `${t('band.high')} ${pct(policy.high)}`),
          h('span', null, `100%`)));
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toLocaleString();
    }

    function Projection({ t, projection }) {
      if (projection === null || projection === undefined || projection.available !== true) {
        return h('p', { style: { ...S.hint, marginTop: 12 } }, t('projection.source') + ': —');
      }
      const rows = [
        ['projection.context', formatNumber(projection.contextWindow)],
        ['projection.reserved', formatNumber(projection.reservedTokens)],
        ['projection.message', formatNumber(projection.messageBudget)],
        ['projection.threshold', formatNumber(projection.baseThresholdTokens)],
        ['projection.retain', formatNumber(projection.baseRetainTokens)],
        ['projection.pass', formatNumber(projection.basePassTokens)],
        ['projection.setpoint', formatNumber(projection.bandSetpointTokens)],
        ['projection.protect', formatNumber(projection.bandProtectTokens)],
      ];
      return h('div', null,
        h('div', { style: S.grid }, ...rows.map(([key, value]) => h(KV, { key, label: t(key), value }))),
        h('div', { style: { ...S.row, borderTop: 'none', paddingTop: 10 } },
          h('span', { style: S.rowLabel }, t('projection.source')),
          h('span', { style: S.mono }, `${projection.provider}/${projection.model} · ${projection.source}`)),
        projection.baseValid === false
          ? h('p', { style: { ...S.hint, marginTop: 4, color: 'var(--dsw-alias-state-error-primary)' } }, t('projection.invalid'))
          : null);
    }

    function Passes({ t, passes }) {
      if (!Array.isArray(passes) || passes.length === 0) {
        return h('p', { style: { ...S.hint, marginTop: 10 } }, t('passes.empty'));
      }
      return h('div', { style: { marginTop: 8 } }, ...passes.map((pass, index) => h('div', {
        key: `${pass.at}-${index}`,
        style: S.row,
      },
      h('span', { style: S.rowLabel }, new Date(pass.at).toLocaleTimeString()),
      h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px' } },
        h('span', { style: S.mono }, `seq ${pass.start}–${pass.end}`),
        h('span', null, `${t('passes.count')} ${pass.count}`),
        h('span', null, `${t('passes.tokens')} ${formatNumber(pass.tokens)}`),
        h('span', { style: S.rowLabel }, pass.reason)))));
    }

    function PanelIcon({ size = 18, active = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.78 },
      },
      h('path', {
        d: 'M4 17.5c2.2-6.8 13.6-6.8 16 0',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M3 20h18',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        opacity: 0.45,
      }),
      h('circle', { cx: 12, cy: 8.2, r: 2.1, fill: 'currentColor' }));
    }

    /**
     * 开始页「更多工具」里的入口。
     * 注意：组件在 factory 作用域里，拿不到 apply(ctx) 的 ctx；
     * 所以真正的打开动作由 apply 通过 inject 传进来（它才持有 ctx）。
     */
    function GuideTagsRow({ open }) {
      const [status, setStatus] = React.useState('');
      const onClick = () => {
        try {
          setStatus(String(open()));
        } catch (error) {
          setStatus('失败：' + String(error?.message ?? error));
        }
      };
      return h('button', {
        type: 'button',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '8px 10px', background: 'transparent', border: 'none',
          color: 'inherit', cursor: 'pointer', textAlign: 'left', fontSize: 12,
        },
        onClick,
      },
        h('span', { style: { opacity: 0.7 } }, 'B'),
        h('span', null, 'A / B / C / K 记忆标签'),
        status ? h('span', { style: { marginLeft: 'auto', opacity: 0.65, fontSize: 10 } }, status) : null);
    }

    function FacetView({ panel, onShowTags }) {
      const box = { padding: '8px 10px', fontSize: 12, lineHeight: 1.5 };
      const row = { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0' };
      const pair = { display: 'flex', gap: 6, alignItems: 'baseline', marginRight: 8 };
      const current = panel?.currentTopic;
      const curve = panel?.curve ?? [];
      const max = Math.max(0.0001, ...curve.map((point) => point.smoothed ?? 0));
      const points = curve.map((point, index) => {
        const x = curve.length <= 1 ? 0 : (index / (curve.length - 1)) * 300;
        const y = 54 - ((point.smoothed ?? 0) / max) * 48;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return h('div', { style: box },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } },
          '当前话题：' + (current?.alias ?? '—')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', marginBottom: 8 } },
          ...(current?.pairs ?? []).map((item) => h('span', { key: item.slot + ':' + item.value, style: pair },
            h('span', { style: { opacity: 0.7 } }, item.slot), h('span', null, item.value),
            h('span', { style: { opacity: 0.55 } }, item.turns + ' 轮')))),
        h('div', { style: { opacity: 0.6, marginBottom: 8 } },
          '总 ' + (panel?.totalTurns ?? 0) + ' turn · facet 计数 ' + (panel?.facetSum ?? 0) + ' · unknown ' + (panel?.unknown ?? 0)),
        curve.length > 0 ? h('svg', { viewBox: '0 0 300 60', width: '100%', height: 60, style: { display: 'block', marginBottom: 8 } },
          h('polyline', { points, fill: 'none', stroke: 'var(--dsw-alias-accent, #4ea1ff)', strokeWidth: 2 })) : null,
        h('div', { style: { opacity: 0.55, fontSize: 11 } }, '曲线：当前话题在历史窗口的敏感度'),
        h('button', {
          type: 'button',
          style: { ...S.button, marginTop: 8 },
          onClick: onShowTags,
        }, '显示 B / C / K 标签'));
    }

    /** 右侧栏「B / C / K 标签」页：只读计数。 */
    function TagsPanel({ sessionId, useTabInfo } = {}) {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null;
      const closedRef = React.useRef(false);
      React.useEffect(() => {
        if (closedRef.current) return;
        if (state.status !== 'ready' || !['not-continuity-session', 'persona-disabled'].includes(state.data?.error)) return;
        closedRef.current = true;
        try { tabInfo?.tab?.actions?.close?.(); } catch { /* ignore */ }
      }, [state.status, state.data, tabInfo]);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const url = sessionId ? `${BC_URL}?sessionId=${encodeURIComponent(sessionId)}` : BC_URL;
            const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (alive) setState({ status: 'ready', data, error: null });
          } catch (error) {
            if (alive) setState({ status: 'error', data: null, error: String(error?.message ?? error) });
          }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);

      const box = {
        padding: '8px 10px',
        fontSize: 12,
        lineHeight: 1.5,
        maxHeight: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
        scrollbarGutter: 'stable',
      };
      const row = { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0' };
      const count = { marginLeft: 'auto', opacity: 0.55, fontVariantNumeric: 'tabular-nums' };

      if (state.status === 'loading') return h('div', { style: box }, '读取中…');
      if (state.status === 'error') return h('div', { style: box }, '读不到 bc-index.json：' + state.error);
      const data = state.data;
      if (data && data.available === false) {
        return h('div', { style: box },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'A / B / C / K 标签'),
          h('div', { style: { opacity: 0.65 } }, '还没有 B 索引：' + (data.error ?? 'unknown')));
      }
      return h('div', { style: box },
        h('div', { style: { marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid rgba(127,127,127,0.25)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'A 概念（轮数=索引实算）'),
          ...(data?.aLabels ?? []).length > 0
            ? (data.aLabels ?? []).map((item) => h('div', {
              key: 'A:' + item.label,
              style: { ...row, flexDirection: 'column', alignItems: 'stretch', gap: 2 },
            },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6 } },
              h('span', null, item.label),
              h('span', { style: count }, (item.turns ?? 0) + ' 轮')),
            h('div', { style: { opacity: 0.55, fontSize: 10 } }, item.description ?? '')))
            : [h('div', { style: { opacity: 0.6 } }, '空表 · 本 session 还没有 A 概念')]),
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'B 通用标签'),
        h('div', { style: { opacity: 0.6, marginBottom: 8 } },
          '覆盖 turn ' + (data?.firstTurn ?? '?') + '–' + (data?.lastTurn ?? '?')
          + ' · 截至 ' + (data?.updatedAt ? new Date(data.updatedAt).toLocaleString() : '?')
          + ' · ' + (data?.totalTurns ?? 0) + ' 轮 · weak ' + (data?.weakTurns ?? 0)),
        ...((data?.labels ?? []).length > 0
          ? (data.labels ?? []).map((item) => h('div', {
            key: 'B:' + item.label,
            style: { ...row, justifyContent: 'space-between' },
          }, h('span', null, item.label), h('span', { style: count }, item.turns + ' 轮')))
          : [h('div', { style: { opacity: 0.6 } }, '空表 · 本 session 还没有 B 标签')]),
        h('div', { style: { marginTop: 10, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.25)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'K 特殊关键词'),
          ...((data?.kLabels ?? []).length > 0
            ? (data.kLabels ?? []).map((item) => h('div', {
              key: 'K:' + item.label,
              style: { ...row, justifyContent: 'space-between' },
            }, h('span', null, item.label), h('span', { style: count }, item.turns + ' 轮')))
            : [h('div', { style: { opacity: 0.6 } }, '空表 · 本 session 还没有 K 关键词')])),
        h('div', { style: { marginTop: 10, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.25)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'C 用户词'),
          ...((data?.cLabels ?? []).length > 0
            ? (data.cLabels ?? []).map((item) => h('div', {
              key: 'C:' + item.label,
              style: { ...row, flexDirection: 'column', alignItems: 'stretch', gap: 2 },
            },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6 } },
              h('span', null, item.label), h('span', { style: count }, item.turns + ' 轮')),
            h('div', { style: { opacity: 0.55, fontSize: 10 } },
              (item.concepts ?? []).join(' / ') + (item.summary ? ' (摘要)' : '')),
            item.summary ? h('div', { style: { opacity: 0.5, fontSize: 10 } }, item.summary) : null))
            : [h('div', { style: { opacity: 0.6 } }, '空表 · 本 session 还没有 C 用户词')])),
        h('div', { style: { marginTop: 10, paddingTop: 6, borderTop: '1px solid rgba(127,127,127,0.25)', opacity: 0.7 } },
          'A / B / C / K 均为本 session 自己的表；空表是合法初始状态；点击追忆时再由 recall() 返回候选。'));
    }

    function TagsTitle() {
      return h('span', null, 'A / B / C / K 标签');
    }

    function makePanel(ctx) {
      return function ContinuityPanel() {
        const t = useTranslate(ctx);
        const snapshot = useSnapshot();
        const data = snapshot.data;
        const policy = data?.engine?.policy ?? {
          setpoint: 0.60,
          high: 0.60,
          low: 0.40,
          emergency: 0.65,
          emergencyTo: 0.42,
          k: 0.4,
          maxPerBatch: 190000,
          minAction: 24000,
          protect: 0.30,
        };

        const header = h('header', null,
          h('div', { style: S.eyebrow }, t('panel.eyebrow')),
          h('h1', { style: S.h1 }, t('panel.title')),
          h('p', { style: S.subtitle }, t('panel.subtitle')),
          h('div', { style: S.badges },
            data?.engine
              ? h(Badge, { tone: 'ok' }, t('status.engine'))
              : h(Badge, { tone: 'idle' }, t('status.inert')),
            h(Badge, null, fmt(t('status.host'), { version: data?.plugin?.version ?? '—' })),
            data?.generatedAt ? h(Badge, null, fmt(t('status.updated'), {
              time: new Date(data.generatedAt).toLocaleTimeString(),
            })) : null));

        if (snapshot.status === 'error' && data === null) {
          return h('div', { style: S.page }, h('div', { style: S.inner }, header,
            h(Card, { title: t('error.title'), hint: null },
              h('p', { style: { ...S.hint, marginTop: 8 } }, fmt(t('error.body'), { message: snapshot.error ?? 'unknown' })),
              h('button', {
                type: 'button',
                style: { ...S.button, marginTop: 12 },
                onClick: () => window.location.reload(),
              }, t('error.reload')))));
        }

        return h('div', { style: S.page },
          h('div', { style: S.inner },
            header,

            h(Card, { title: 'A / B / C / K 记忆标签', hint: 'A 展示 + B 通用概念 + C 用户词 + K 特殊关键词· 只读' },
              h(TagsPanel, { compact: true }),
              h('button', {
                type: 'button',
                style: { ...S.button, marginTop: 8 },
                onClick: () => { try { ctx.sidebarRight?.openTab?.('continuityTags'); } catch { /* 右侧栏不可用时忽略 */ } },
              }, '在右侧栏打开')),

            h(Card, { title: t('band.title'), hint: t('band.hint') },
              h(BandBar, { t, policy }),
              h('div', { style: S.grid },
                h(KV, { label: t('band.setpoint'), value: pct(policy.setpoint) }),
                h(KV, { label: t('band.high'), value: pct(policy.high) }),
                h(KV, { label: t('band.low'), value: pct(policy.low) }),
                h(KV, { label: t('band.emergency'), value: pct(policy.emergency) }),
                h(KV, { label: t('band.protect'), value: pct(policy.protect) }),
                h(KV, { label: t('band.max'), value: formatNumber(policy.maxPerBatch) }),
                h(KV, { label: t('band.min'), value: formatNumber(policy.minAction) }))),

            h(Card, { title: t('projection.title'), hint: t('projection.hint') },
              h(Projection, { t, projection: data?.projection ?? null })),

            h(Card, { title: t('provenance.title'), hint: t('provenance.hint') },
              h('p', { style: { ...S.k, marginTop: 10 } }, t('provenance.convention')),
              h('pre', { style: S.pre }, data?.provenance?.convention ?? '—'),
              h('p', { style: { ...S.k, marginTop: 12 } }, t('provenance.sample')),
              h('pre', { style: S.pre }, data?.provenance?.sample ?? '—')),

            h(Card, { title: t('passes.title'), hint: null },
              h(Passes, { t, passes: data?.passes ?? [] })),

            h(Card, { title: t('facts.title'), hint: t('facts.hint') },
              h('div', { style: S.list }, ...(data?.facts ?? []).map((fact, index) => h('div', {
                key: `${fact.label}-${index}`,
                style: { ...S.row, ...(index === 0 ? { borderTop: 'none' } : {}) },
              },
              h('span', { style: S.rowLabel }, fact.label),
              h('span', { style: S.mono }, fact.value))))),

            h(Card, { title: t('try.title'), hint: null },
              h('ol', { style: S.steps },
                h('li', null, t('try.one')),
                h('li', null, t('try.two')),
                h('li', null, t('try.three')),
                h('li', null, t('try.four')))),

            h('p', { style: { ...S.hint, textAlign: 'center', margin: '4px 0 0' } }, t('footer'))));
      };
    }

    // 宿主能力逐个检测 + 每个注册点单独兜底：
    // 一个 API 缺失/签名不同，只跳过那一项，绝不把整个 renderer 拖崩
    // （2026-10-29：rc2 上装右侧栏标签，宿主少一个服务 → Renderer boot failed）。
    const safe = (label, fn) => {
      try { return fn(); } catch (error) {
        try {
          console.warn('[dsh-continuity] 跳过 ' + label + '：' + String(error?.name ?? 'Error') + ': ' + String(error?.message ?? error));
        } catch { /* console 不可用也不能抛 */ }
        return undefined;
      }
    };
    const effect = (ctx, fn) => safe('effect', () => {
      const value = fn();
      if (typeof ctx?.effect === 'function') return ctx.effect(() => value);
      return value;
    });

    return {
      // 必须声明：inject 是"等这些服务就绪再 apply"的机制。
      // 去掉它（我试过）会让 apply 跑在服务注册之前，能力检测看到 undefined，
      // 右侧栏标签整块被跳过——标签页就消失了（2026-10-29 实测）。
      // 真正的防崩措施在 apply 内部：每项注册单独兜底，一项失败不连坐。
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const hasSlots = ctx?.slots !== undefined && ctx.slots !== null && typeof ctx.slots.inject === 'function';
        const hasLocale = ctx?.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function';
        const hasTabs = ctx?.sidebarRightTabs !== undefined
          && ctx.sidebarRightTabs !== null
          && typeof ctx.sidebarRightTabs.register === 'function';

        if (hasLocale) {
          effect(ctx, () => {
            const disposeEn = ctx.locale.register(NS, 'en', EN);
            const disposeZh = ctx.locale.register(NS, 'zh', ZH);
            return () => {
              try { disposeZh(); } catch { /* ignore */ }
              try { disposeEn(); } catch { /* ignore */ }
            };
          });
        }

        // 没有 slots 就什么都做不了：安静退出，不抛。
        if (!hasSlots) return;

        const translate = hasLocale && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => key;

        safe('sidebar.panellist', () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'continuity',
          order: 20,
          label: () => translate('panel.title'),
        }, PanelIcon)));

        // 右侧栏：宿主没有这个服务就整块跳过。
        if (hasTabs) {
          effect(ctx, () => ctx.sidebarRightTabs.register({
            id: TAGS_TAB_ID,
            kind: TAGS_TAB_KIND,
            priority: 'builtin',
            title: () => 'A / B / C / K 标签',
          }));
        }

        // 开始页「更多工具」入口
        safe('sidebar.right.tab.guide.actions', () => ctx.slots.inject('sidebar.right.tab.guide.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.guide.actions',
          id: 'continuity-tags-open',
          order: 10,
          locale: NS,
          inject: () => ({
            open: () => {
              if (ctx.sidebarRight === undefined || typeof ctx.sidebarRight.openTab !== 'function') {
                return '右侧栏服务不可用（这个宿主版本没有 sidebarRight）';
              }
              try {
                ctx.sidebarRight.openTab(TAGS_TAB_KIND);
                return '已调用 openTab(' + TAGS_TAB_KIND + ')';
              } catch (error) {
                return '失败：' + String(error?.message ?? error);
              }
            },
          }),
        }, GuideTagsRow)));

        // tab 正文 + 标题（宿主没有 sidebarRightTabs 时这两个 seat 也没意义，但注册不抛就留着）
        safe('sidebar.right.pane.tab', () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAGS_TAB_ID,
          locale: NS,
        }, TagsPanel)));
        safe('sidebar.right.pane.tab.title', () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAGS_TAB_ID,
          locale: NS,
        }, TagsTitle)));
        safe('main', () => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'continuity',
        }, makePanel(ctx))));
      },
    };
  },
});
