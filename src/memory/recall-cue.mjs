/**
 * High-precision explicit recall cues.
 * Deliberately does not fire on bare "之前", "那个", or "继续".
 */
const CUES = [
  /上次/,
  /上回/,
  /上一次/,
  /前一回/,
  /之前我们/,
  /之前那次/,
  /之前那个/,
  /之前我(?:说|提|讲)过?/,
  /以前我们/,
  /以前那次/,
  /还记得/,
  /记得上次/,
  /记得之前/,
  /回到(?:刚才|之前|那个|上次)/,
  /接着(?:上次|之前)/,
  /那个(?:事|项目|话题|东西|办法|决定|问题)/,
];

export function detectRecallCue(text) {
  // Quoted cue words are usually meta-discussion ("if I say '上次' ..."),
  // not an actual request to recall.
  const source = String(text ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/「[^」]*」/g, ' ')
    .replace(/"[^"]*"/g, ' ');
  for (const pattern of CUES) {
    const match = source.match(pattern);
    if (match) return { hit: true, cue: match[0], index: match.index ?? 0, pattern: pattern.source };
  }
  return { hit: false, cue: null, index: -1, pattern: null };
}

export function shouldTriggerRecall(text) {
  return detectRecallCue(text).hit;
}

export const RECALL_CUE_PATTERNS = CUES.map((pattern) => pattern.source);
