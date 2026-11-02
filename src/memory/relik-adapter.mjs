/**
 * Adapter for ReLiK entity-linking output.
 * Accepts the documented RelikOutput shape:
 * { text, spans: [{start,end,text}], candidates: { span: [ [ {text,id}, ... ] ] } }
 */
import { normalizeEntityLinks } from './structured-adapters.mjs';

export function relikToLinks(output = {}) {
  const spans = Array.isArray(output.spans) ? output.spans : [];
  const candidateGroups = output.candidates?.span ?? [];
  const links = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    const candidates = candidateGroups[index]?.[0] ?? candidateGroups[0]?.[0] ?? [];
    const top = candidates.find((candidate) => candidate.text === span.label || candidate.text === span.text) ?? candidates[0] ?? null;
    links.push({
      text: span.text ?? output.text?.slice(span.start, span.end) ?? '',
      entityId: top?.id ?? null,
      score: Number.isFinite(top?.score) ? top.score : null,
      start: span.start ?? null,
      end: span.end ?? null,
    });
  }
  return normalizeEntityLinks(links);
}
