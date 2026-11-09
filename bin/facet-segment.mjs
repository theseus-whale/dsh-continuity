import fs from 'node:fs';
import { deserializePrototypes, predictEmbedding } from '../src/facets/embedding.mjs';

const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync('C:/Users/example/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-prototypes.json', 'utf8')));
const text = `宁把手里那只凉箍交给柯林，箍口朝上塞进他布袋：

「你拿着，别落地，也别让它见水。」

然后他自己转到闸门侧面去找那个起闸的轮子——不是去接，是去卡：

「闸一开就接人是吧？」他蹲下去看链条和卡齿，「那今晚就先让闸开不了。」

（@Coo：闸的起落机构是什么样的？能卡在哪儿？）`;

const segments = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).map((part) => ({
  kind: /^[（(]\s*@/.test(part) ? 'ooc' : 'story',
  text: part,
}));
const out = [];
for (const segment of segments) {
  if (segment.kind === 'ooc') {
    out.push({ ...segment, facets: null, reason: 'ooc-skip' });
    continue;
  }
  const result = await predictEmbedding(prototypes, segment.text);
  const accepted = (result.confidence.activity ?? 0) >= 0.05 && (result.confidence.topic ?? 0) >= 0.03;
  out.push({
    ...segment,
    facets: accepted ? result.facets : null,
    confidence: result.confidence,
    reason: accepted ? 'accepted' : 'low-confidence',
  });
}
console.log(JSON.stringify(out, null, 2));
