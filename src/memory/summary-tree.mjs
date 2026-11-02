/**
 * Deterministic, versioned extractive summary tree.
 * Leaves are turns; segments and chapters only point at children and seq ranges.
 * No LLM is used here, so rebuilding is byte-stable.
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

export function buildSummaryTree(records, {
  segmentSize = 8,
  chapterSize = 8,
} = {}) {
  const leaves = records.map((record, index) => ({
    id: nodeId('turn', index),
    level: 'turn',
    parentId: null,
    childIds: [],
    turn: record.turn,
    seqStart: record.seqStart,
    seqEnd: record.seqEnd,
    summary: clip(record.text, 280),
    sourceHash: record.hash,
  }));

  const segments = [];
  for (let start = 0; start < leaves.length; start += segmentSize) {
    const children = leaves.slice(start, start + segmentSize);
    const id = nodeId('segment', segments.length);
    const summary = clip(children.map((child) => child.summary).join(' / '), 700);
    const node = {
      id,
      level: 'segment',
      parentId: null,
      childIds: children.map((child) => child.id),
      seqStart: children[0].seqStart,
      seqEnd: children[children.length - 1].seqEnd,
      firstTurn: children[0].turn,
      lastTurn: children[children.length - 1].turn,
      summary,
      sourceHash: sha256(children.map((child) => child.sourceHash).join('')),
    };
    for (const child of children) child.parentId = id;
    segments.push(node);
  }

  const chapters = [];
  for (let start = 0; start < segments.length; start += chapterSize) {
    const children = segments.slice(start, start + chapterSize);
    const id = nodeId('chapter', chapters.length);
    const summary = clip(children.map((child) => child.summary).join(' / '), 1200);
    const node = {
      id,
      level: 'chapter',
      parentId: null,
      childIds: children.map((child) => child.id),
      seqStart: children[0].seqStart,
      seqEnd: children[children.length - 1].seqEnd,
      firstTurn: children[0].firstTurn,
      lastTurn: children[children.length - 1].lastTurn,
      summary,
      sourceHash: sha256(children.map((child) => child.sourceHash).join('')),
    };
    for (const child of children) child.parentId = id;
    chapters.push(node);
  }

  const nodes = [...leaves, ...segments, ...chapters];
  const treeRootHash = sha256(nodes.map((node) => node.sourceHash).join(''));
  return {
    schema: 1,
    version: 1,
    segmentSize,
    chapterSize,
    nodeCount: nodes.length,
    levels: { turn: leaves.length, segment: segments.length, chapter: chapters.length },
    treeRootHash,
    nodes,
  };
}

export function verifySummaryTree(tree) {
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
  return { ok: errors.length === 0, errors };
}
