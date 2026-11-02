/**
 * Find a TAG declaration in an assistant message.
 *
 * The gate accepts the first non-empty, non-fenced line OR the last five
 * non-empty, non-fenced lines. Last-five wins when both contain a TAG, which
 * keeps the old "末尾优先" behavior. Fenced examples are never declarations.
 */
export function tagDeclarationCandidates(text, { tailLimit = 5 } = {}) {
  const rawLines = String(text ?? '').split('\n');
  const fenced = [];
  let inFence = false;
  for (const line of rawLines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      fenced.push(true);
      continue;
    }
    fenced.push(inFence);
  }

  const candidates = [];
  const tailIndexes = new Set();
  for (let i = rawLines.length - 1; i >= 0; i -= 1) {
    const line = rawLines[i].trim();
    if (line.length === 0 || fenced[i]) continue;
    candidates.push(line);
    tailIndexes.add(i);
    if (candidates.length >= tailLimit) break;
  }

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (line.length === 0 || fenced[i]) continue;
    if (!tailIndexes.has(i)) candidates.push(line);
    break;
  }
  return candidates;
}

export function findTagDeclaration(text) {
  return tagDeclarationCandidates(text).find((line) => /^TAG\s*[:：]/i.test(line)) ?? null;
}
