/**
 * Event segmentation for alias formation.
 * A boundary is opened when activity or topic changes, or when the caller
 * supplies an explicit boundary. Event IDs are stable for the session.
 */
export class EventSegmenter {
  constructor({ eventId = 0, lastFacets = null } = {}) {
    this.eventId = eventId;
    this.lastFacets = lastFacets;
    this.boundaries = [];
  }

  observe({ facets = {}, nowTurn = 0, explicitBoundary = false, reason = null } = {}) {
    const changed = this.lastFacets !== null
      && (this.lastFacets.activity !== facets.activity || this.lastFacets.topic !== facets.topic);
    const boundary = this.lastFacets === null || changed || explicitBoundary;
    if (boundary && this.lastFacets !== null) {
      this.eventId += 1;
      this.boundaries.push({ eventId: this.eventId, nowTurn, reason: reason ?? (changed ? 'facet-change' : 'explicit') });
    }
    this.lastFacets = { ...facets };
    return { eventId: this.eventId, boundary, reason: boundary ? reason ?? 'start' : null };
  }
}

export function segmentEvents(turns) {
  const segmenter = new EventSegmenter();
  return turns.map((turn, index) => {
    const result = segmenter.observe({
      facets: turn.facets,
      nowTurn: turn.turn ?? index,
      explicitBoundary: turn.boundary === true,
    });
    return { ...turn, eventId: result.eventId, boundary: result.boundary };
  });
}
