/**
 * Event-aligned summary tree.
 *
 * Leaves are turns. Segment nodes are event groups, never fixed-size windows.
 * Chapters group consecutive event segments. Extractive and deterministic.
 */
import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function clip(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function nodeId(level, index) {
  return `${level}-${String(index + 1).padStart(5, '0')}`;
}

export function buildEventSummaryTree(records, { eventIds = null, chapterSize = 8 } = {}) {
  const ordered = [...records].sort((a, b) => a.turn - b.turn);
  const eventOf = (record, index) => String(eventIds?.[record.turn] ?? eventIds?.[index] ?? `turn:${record.turn}`);

  const leaves = ordered.map((record, index) => ({
    id: nodeId('turn', index),
    level: 'turn',
    parentId: null,
    childIds: [],
    turn: record.turn,
    eventId: eventOf(record, index),
    seqStart: record.seqStart,
    seqEnd: record.seqEnd,
    summary: clip(record.text, 280),
    sourceHash: record.hash,
  }));

  const groups = [];
  for (const leaf of leaves) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.eventId === leaf.eventId) last.leaves.push(leaf);
    else groups.push({ eventId: leaf.eventId, leaves: [leaf] });
  }

  const segments = groups.map((group, index) => {
    const id = nodeId('segment', index);
    const children = group.leaves;
    const node = {
      id,
      level: 'segment',
      parentId: null,
      childIds: children.map((child) => child.id),
      eventId: group.eventId,
      seqStart: children[0].seqStart,
      seqEnd: children[children.length - 1].seqEnd,
      firstTurn: children[0].turn,
      lastTurn: children[children.length - 1].turn,
      summary: clip(children.map((child) => child.summary).join(' / '), 700),
      sourceHash: sha256(children.map((child) => child.sourceHash).join('')),
    };
    for (const child of children) child.parentId = id;
    return node;
  });

  const chapters = [];
  for (let start = 0; start < segments.length; start += chapterSize) {
    const children = segments.slice(start, start + chapterSize);
    const id = nodeId('chapter', chapters.length);
    const node = {
      id,
      level: 'chapter',
      parentId: null,
      childIds: children.map((child) => child.id),
      eventIds: children.map((child) => child.eventId),
      seqStart: children[0].seqStart,
      seqEnd: children[children.length - 1].seqEnd,
      firstTurn: children[0].firstTurn,
      lastTurn: children[children.length - 1].lastTurn,
      summary: clip(children.map((child) => child.summary).join(' / '), 1200),
      sourceHash: sha256(children.map((child) => child.sourceHash).join('')),
    };
    for (const child of children) child.parentId = id;
    chapters.push(node);
  }

  return {
    schema: 1,
    version: 1,
    mode: 'event-aligned',
    chapterSize,
    nodeCount: leaves.length + segments.length + chapters.length,
    levels: { turn: leaves.length, segment: segments.length, chapter: chapters.length },
    treeRootHash: sha256([...leaves, ...segments, ...chapters].map((node) => node.sourceHash).join('')),
    nodes: [...leaves, ...segments, ...chapters],
  };
}

export function verifyEventSummaryTree(tree) {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const errors = [];
  for (const node of tree.nodes) {
    for (const childId of node.childIds) {
      const child = byId.get(childId);
      if (child === undefined) {
        errors.push({ id: node.id, reason: 'missing-child', childId });
        continue;
      }
      if (child.parentId !== node.id) errors.push({ id: child.id, reason: 'parent-mismatch' });
      if (child.seqStart < node.seqStart || child.seqEnd > node.seqEnd) {
        errors.push({ id: child.id, reason: 'child-outside-parent' });
      }
    }
  }
  for (const segment of tree.nodes.filter((node) => node.level === 'segment')) {
    const childEvents = new Set(segment.childIds.map((childId) => byId.get(childId)?.eventId));
    if (childEvents.size !== 1 || !childEvents.has(segment.eventId)) {
      errors.push({ id: segment.id, reason: 'segment-crosses-event' });
    }
  }
  return { ok: errors.length === 0, errors };
}
