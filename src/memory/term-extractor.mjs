/**
 * Term candidate extraction.
 * Extracts definitional names, quoted names, and "X的规则/设定" patterns.
 * Source weighting is applied later by the referent ledger.
 */

const DEFINITION = /(?:叫做|叫|名为|称为|名字是|称作)\s*[《「“"]?([\u4e00-\u9fffA-Za-z0-9_·-]{2,12})[》」”"]?/gu;
const QUOTED = /[《「“"]([^》」”"\n]{2,16})[》」”"]/gu;
const BEFORE_RULE = /([\u4e00-\u9fffA-Za-z0-9_·-]{2,10})(?:的)?(?:规则|设定|世界观|背景|系统)/gu;
const STOP = /^(什么|这个|那个|我们|你们|他们|最近|现在|已经|可以|需要|因为|所以|问题|东西|地方|名字|标签|备份|一个|一种|一下|这些|那些)$/u;

export function normalizeTerm(value) {
  return String(value ?? '')
    .replace(/[《》「」“”"'`]/g, '')
    .replace(/[，。！？、；：\s]+$/g, '')
    .trim();
}

function validTerm(term) {
  if (term.length < 2 || term.length > 12) return false;
  if (STOP.test(term)) return false;
  if (/^[0-9]+$/u.test(term)) return false;
  if (/[，。！？、；：]/u.test(term)) return false;
  return true;
}

export function extractTerms(text, { max = 8 } = {}) {
  const source = String(text ?? '');
  const found = [];
  const add = (value, kind, index) => {
    const term = normalizeTerm(value);
    if (!validTerm(term)) return;
    if (found.some((item) => item.term === term)) return;
    found.push({ term, kind, index });
  };
  for (const regex of [DEFINITION, QUOTED, BEFORE_RULE]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      add(match[1], regex === DEFINITION ? 'definition' : regex === QUOTED ? 'quoted' : 'mention', match.index);
    }
  }
  return found.sort((a, b) => a.index - b.index).slice(0, max);
}
