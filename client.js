/**
 * dsh-continuity — Web Client half.
 *
 * Registers the left-sidebar entry (`sidebar.panellist`) and the main panel it
 * opens (`main`, keyed by the same id). Visible text is registered through the
 * Client locale service; colors and surfaces come from `--dsw-alias-*` tokens.
 * The data comes from the Host route registered by `src/index.mjs`.
 */
window.__ModuleLoader__.load({
  id: '@theseus-whale/dsh-continuity',
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

    const EN = {
      'panel.eyebrow': 'DSH CONTINUITY',
      'panel.title': 'Continuity',
      'panel.subtitle': 'Memory resonance and unified fold. Keep a verbatim recent window, with every summary linked to its canonical raw records.',
      'status.engine': 'Engine mounted',
      'status.inert': 'Engine not mounted',
      'status.host': 'Host {version}',
      'status.updated': 'Updated {time}',
      'band.title': 'Compaction waterlines',
      'band.hint': 'Measure → plan → fold the oldest balanced range, never the protected tail.',
      'band.setpoint': 'setpoint',
      'band.high': 'high',
      'band.low': 'low',
      'band.emergency': 'emergency',
      'band.protect': 'protect',
      'band.max': 'max / pass',
      'band.min': 'min action',
      'projection.title': 'Current model window',
      'projection.hint': 'Measured from the active model route and the current compaction policy.',
      'projection.context': 'context window',
      'projection.reserved': 'reserved output',
      'projection.message': 'message budget',
      'projection.threshold': 'stock threshold',
      'projection.retain': 'stock retain',
      'projection.pass': 'stock pass',
      'projection.setpoint': 'current setpoint',
      'projection.protect': 'current protect',
      'projection.source': 'source',
      'projection.invalid': 'retain ≥ threshold — this config would be rejected',
      'runtime.title': 'Runtime status',
      'runtime.hint': 'Observed capabilities and evidence; not a success claim without an observation.',
      'runtime.model': 'Model route',
      'runtime.bge': 'BGE / vectors',
      'runtime.writeIndex': 'Write-time index',
      'runtime.sessions': 'Authorized sessions',
      'runtime.errors': 'Recent errors',
      'runtime.noErrors': 'No recorded error',
      'runtime.resolved': 'metadata resolved',
      'runtime.unresolved': 'metadata unavailable',
      'runtime.vectors': 'vectors present',
      'runtime.notObserved': 'not observed',
      'runtime.enabled': 'enabled',
      'runtime.disabled': 'disabled',
      'runtime.records': 'raw records',
      'runtime.reconciled': 'sessions reconciled',
      'tools.title': 'Tool catalog',
      'tools.hint': 'Tools provided by this package, with usage notes; current visibility is reported separately.',
      'tools.empty': 'No tool catalog data is available yet.',
      'tools.visible': 'visible in sessions',
      'tools.notObserved': 'current visibility not observed',
      'tools.parameters': 'Parameters',
      'error.title': 'The state route is not answering',
      'error.body': 'The sidebar entry is registered, but the Host route returned: {message}',
      'error.reload': 'Reload page',
      'footer': 'Read-only runtime indicators. This panel does not modify raw history.',
    };

    const ZH = {
      'panel.eyebrow': 'DSH 连续性',
      'panel.title': '连续性',
      'panel.subtitle': '记忆共振与统一折叠：保留最近的逐字窗口，摘要与原文保持可核验的对应关系。',
      'status.engine': '引擎已挂载',
      'status.inert': '引擎未挂载',
      'status.host': '宿主 {version}',
      'status.updated': '更新于 {time}',
      'band.title': '折叠水位',
      'band.hint': '测量 → 规划 → 折叠最旧且边界平衡的区间，绝不折进受保护的尾部。',
      'band.setpoint': '设定点',
      'band.high': '高水位',
      'band.low': '低水位',
      'band.emergency': '紧急',
      'band.protect': '保护',
      'band.max': '单次上限',
      'band.min': '最小动作',
      'projection.title': '当前模型窗口',
      'projection.hint': '根据当前模型路由与当前折叠策略计算。',
      'projection.context': '上下文窗口',
      'projection.reserved': '输出预留',
      'projection.message': '消息预算',
      'projection.threshold': '自带后端阈值',
      'projection.retain': '自带后端保留',
      'projection.pass': '自带后端单次压缩量',
      'projection.setpoint': '当前设定点',
      'projection.protect': '当前保护',
      'projection.source': '来源',
      'projection.invalid': '保留 ≥ 阈值 —— 该配置会被拒绝',
      'runtime.title': '运行状态',
      'runtime.hint': '只展示实际观测；没有观测时不宣称成功。',
      'runtime.model': '模型路由',
      'runtime.bge': 'BGE／向量',
      'runtime.writeIndex': '写入即索引',
      'runtime.sessions': '授权会话数',
      'runtime.errors': '最近错误',
      'runtime.noErrors': '没有记录错误',
      'runtime.resolved': '元数据已解析',
      'runtime.unresolved': '元数据不可用',
      'runtime.vectors': '已有向量',
      'runtime.notObserved': '尚未观测',
      'runtime.enabled': '已开启',
      'runtime.disabled': '未开启',
      'runtime.records': '原文索引记录',
      'runtime.reconciled': '已补扫会话',
      'tools.title': '工具汇总',
      'tools.hint': '这里列出本包提供的工具及用途；当前是否可见另行标注。',
      'tools.empty': '暂时没有工具目录数据。',
      'tools.visible': '个会话可见',
      'tools.notObserved': '当前可见性尚未观测',
      'tools.parameters': '参数',
      'error.title': '状态路由没有响应',
      'error.body': '侧栏入口已注册，但宿主路由返回：{message}',
      'error.reload': '刷新页面',
      'footer': '只读运行状态。本面板不会修改原始历史。',
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

    const TOOL_NOTES = {
      memory_rebuild: {
        note: '让 Host 从当前会话第一条可归档原始轮次全量重建语义记忆；调用方 LLM 不逐条写摘要。',
        params: 'action 必填：probe、start、status、cancel、resume；jobId 可选。使用 Host flash 与本地 BGE，只影响当前会话。',
      },
      memory_recall: {
        note: '用自己的话主动去回忆；与自动 memory_cue 共用 Xenova 语义检索，返回相关摘要和原文指针。',
        params: 'query 必填；不是 BM25、精确匹配或 seq 坐标读取。',
      },
      read_seq_range: {
        note: '按当前会话的 seq 范围读取原始对话，用来核对旧消息和精确措辞。',
        params: 'fromSeq、toSeq（起止都包含）；返回有字节上限，截断时必须明确标记。',
      },
      read_raw_chunk: {
        note: '按 chunkId 和字节偏移读取对应的 canonical raw 分段，适合长原文续读。',
        params: 'chunkId 必填；byteOffset、maxBytes 可选；用 nextByteOffset 续读。',
      },
      session_asset: {
        note: '查找当前会话已折叠的非文本附件，返回登记路径和元数据，不把文件内容塞进上下文。',
        params: 'action=get/list；get 需要 seq 或 path，list 可用 limit。',
      },
      child_asset: {
        note: '读取子会话／PTC 交给父会话的产物登记信息，保持父子会话边界。',
        params: 'action=get/list；可用 runId、path 或 limit 定位。',
      },
      ptc_handoff: {
        note: '把 PTC 子任务的结果登记为父会话可见产物，并保留决策、未完成项和来源 seq。',
        params: 'childSessionId、runId、summary 必填；decisions、open、artifacts 等可选。',
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

    function RuntimeStatus({ t, runtime }) {
      const value = runtime ?? {};
      const model = value.model ?? {};
      const bge = value.bge ?? {};
      const write = value.writeIndex ?? {};
      const errors = Array.isArray(value.recentErrors) ? value.recentErrors : [];
      const modelRoute = [model.provider, model.model].filter(Boolean).join('/') || '—';
      const bgeStatus = bge.vectors > 0
        ? `${formatNumber(bge.vectors)} ${t('runtime.vectors')}`
        : t(bge.status === 'not-observed' ? 'runtime.notObserved' : 'runtime.disabled');
      return h('div', null,
        h('div', { style: S.grid },
          h(KV, { label: t('runtime.model'), value: `${modelRoute} · ${t(model.metadataResolved ? 'runtime.resolved' : 'runtime.unresolved')}`, mono: true }),
          h(KV, { label: t('runtime.bge'), value: `${bge.model ?? '—'} · ${bgeStatus}` }),
          h(KV, { label: t('runtime.writeIndex'), value: `${t(write.enabled ? 'runtime.enabled' : 'runtime.disabled')} · ${formatNumber(write.records)} ${t('runtime.records')} · ${formatNumber(write.reconciledSessions)} ${t('runtime.reconciled')}` }),
          h(KV, { label: t('runtime.sessions'), value: formatNumber(value.authorizedSessions) })),
        h('p', { style: { ...S.k, marginTop: 12 } }, t('runtime.errors')),
        errors.length === 0
          ? h('p', { style: S.hint }, t('runtime.noErrors'))
          : h('div', { style: { maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain' } },
            errors.map((error, index) => h('div', { key: index, style: S.row },
              h('span', { style: S.mono }, `${error?.sessionId ? `${error.sessionId} · ` : ''}${String(error?.message ?? error)}`)))),
      );
    }

    function ToolCatalog({ t, catalog }) {
      const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
      if (tools.length === 0) return h('p', { style: { ...S.hint, marginTop: 10 } }, t('tools.empty'));
      return h('div', { style: S.list }, ...tools.map((tool) => {
        const note = TOOL_NOTES[tool.name];
        const schemaParams = Object.keys(tool.parameters?.properties ?? {}).join('、');
        return h('div', { key: tool.name, style: { ...S.row, gridTemplateColumns: 'minmax(150px, 190px) minmax(0, 1fr)' } },
          h('span', { style: S.mono }, tool.name),
          h('div', null,
            h('div', null, note?.note ?? tool.description ?? '—'),
            h('div', { style: { ...S.hint, marginTop: 4 } }, `${t('tools.parameters')}：${note?.params ?? schemaParams ?? '—'}`),
            h('div', { style: { ...S.k, marginTop: 3 } }, catalog?.observed === true
              ? `${tool.visibleSessions ?? 0} ${t('tools.visible')}`
              : t('tools.notObserved'))),
        );
      }));
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
            h(Card, { title: t('runtime.title'), hint: t('runtime.hint') },
              h(RuntimeStatus, { t, runtime: data?.runtime ?? null })),
            h(Card, { title: t('tools.title'), hint: t('tools.hint') },
              h(ToolCatalog, { t, catalog: data?.toolCatalog ?? null })),
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
      inject: ['slots', 'locale'],
      apply(ctx) {
        const hasSlots = ctx?.slots !== undefined && ctx.slots !== null && typeof ctx.slots.inject === 'function';
        const hasLocale = ctx?.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function';
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
        safe('main', () => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'continuity',
        }, makePanel(ctx))));
      },
    };
  },
});
