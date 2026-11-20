let activeService = null;
let unavailableReason = { code: 'host-rebuild-not-ready', message: 'turn-ping Host installation has not completed' };
export function setHostRebuildService(service) {
  activeService = service;
  if (service) unavailableReason = null;
  return service;
}
export function setHostRebuildUnavailable(reason = {}) {
  activeService = null;
  unavailableReason = {
    code: String(reason.code ?? 'host-rebuild-unavailable'),
    message: String(reason.message ?? 'turn-ping Host installation did not complete'),
  };
}
export function getHostRebuildService() { return activeService; }

export function createMemoryRebuildTool({ resolveService = () => activeService, resolveUnavailableReason = () => unavailableReason } = {}) {
  return {
    name: 'memory_rebuild',
    description: 'Ask the DSH Host to rebuild this session\'s full semantic memory index from the first eligible raw turn. The Host—not the calling LLM—writes every summary using its configured flash engine and local BGE. start/resume returns a background job ID; status reports progress; cancel stops shadow work without changing the previous live index. No API key or new session is required.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'cancel', 'resume', 'probe'], description: 'probe one summary without writes; start/resume a full job; query progress; or cancel shadow work.' },
        jobId: { type: 'string', description: 'Optional job ID for status/cancel/resume; defaults to the latest job for this session.' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args = {}, exec = {}) {
      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) throw new Error('memory_rebuild: no current session');
      const service = resolveService(exec);
      if (!service) {
        const reason = resolveUnavailableReason(exec);
        const detail = `${String(reason?.code ?? 'host-rebuild-unavailable')}: ${String(reason?.message ?? 'turn-ping Host installation did not complete')}`;
        throw new Error(`memory_rebuild: Host rebuild service unavailable; ${detail}; check the panel recent error and ~/.dsh/continuity/gate-errors.jsonl`);
      }
      const action = String(args.action ?? 'start');
      const jobId = typeof args.jobId === 'string' && args.jobId ? args.jobId : null;
      let result;
      if (action === 'start') result = await service.start(String(sessionId));
      else if (action === 'resume') result = await service.start(String(sessionId), { resume: true, jobId });
      else if (action === 'probe') result = await service.probe(String(sessionId));
      else if (action === 'status') result = await service.status(String(sessionId), jobId);
      else if (action === 'cancel') result = await service.cancel(String(sessionId), jobId);
      else throw new Error(`memory_rebuild: unknown action ${action}`);
      return JSON.stringify({ ...result, note: action === 'start' || action === 'resume' ? 'Host 后台重建已受理；调用方不需要也不应当逐条编写摘要。' : undefined });
    },
  };
}

export function apply(ctx) {
  const tool = createMemoryRebuildTool();
  ctx.effect(() => ctx.tools.register(tool));
  return tool;
}
export const name = 'memory-rebuild-tool';
export const inject = ['tools'];
