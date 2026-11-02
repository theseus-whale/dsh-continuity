/**
 * Pre-turn integration: one incoming user/Coo message -> facet/event/gate/load.
 * Pure system layer. No live session writes.
 */
import { MemoryLoadState, latestCandidate, candidateSegment } from './load-gate.mjs';
import { EventModelState } from './event-model.mjs';
import { attachStructuredExtraction } from './extraction-adapter.mjs';

export class PreTurnController {
  constructor({ records = [], gate = null, eventModel = null } = {}) {
    this.records = records;
    this.gate = gate ?? new MemoryLoadState();
    this.eventModel = eventModel ?? new EventModelState({ slots: this.gate.loadedFacets });
  }

  async stepAsync({ extractionProvider = null, ...args } = {}) {
    if (!extractionProvider) return this.step(args);
    const extraction = await extractionProvider.extract({ text: args.text });
    if (!extraction.ok) {
      return {
        ok: false,
        extraction,
        gate: this.step({ ...args, eventSlots: args.eventSlots ?? null }),
      };
    }
    const data = extraction.data ?? {};
    const result = attachStructuredExtraction(this, {
      ...args,
      slots: data.slots ?? null,
      srl: data.srl ?? null,
      corefClusters: data.corefClusters ?? [],
      entityLinks: data.entityLinks ?? [],
    });
    return { ok: result.ok, extraction, ...result };
  }

  step({ text, role = 'user', facets = {}, confidence = 1, eventSlots = null, nowTurn = 0 } = {}) {
    if (role === 'assistant') {
      return { action: 'none', reason: 'assistant-text', telemetry: { role } };
    }
    const observed = this.eventModel.observe({ slots: eventSlots ?? facets });
    const candidate = latestCandidate(this.records, 'activity', facets.activity);
    const segment = candidateSegment(this.records, candidate);
    const decision = this.gate.decide({
      text,
      currentFacets: facets,
      confidence,
      nowTurn,
      hasCandidate: candidate !== null,
      candidate,
      role,
      boundaryScore: observed.score,
    });
    if (decision.action === 'load') {
      this.gate.recordLoad({
        facets,
        seq: segment?.seqStart ?? null,
        nowTurn,
        reason: decision.reason,
      });
    }
    return {
      ...decision,
      boundaryScore: observed.score,
      eventId: observed.eventId,
      eventError: observed.error ?? null,
      candidateTurn: candidate?.turn ?? null,
      segment: decision.action === 'none' ? null : segment,
      telemetry: {
        role,
        activity: facets.activity ?? null,
        topic: facets.topic ?? null,
        confidence,
        eventSlots: observed.slots,
        eventChanged: observed.changed,
        gateReason: decision.reason,
      },
    };
  }
}
