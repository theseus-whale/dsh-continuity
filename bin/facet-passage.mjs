import fs from 'node:fs';
import { deserializePrototypes, predictEmbedding } from '../src/facets/embedding.mjs';
import { deserializeClassifier, predictFacets } from '../src/facets/classifier.mjs';

const full = `宁把手里那只凉箍交给柯林，箍口朝上塞进他布袋：

「你拿着，别落地，也别让它见水。」

然后他自己转到闸门侧面去找那个起闸的轮子——不是去接，是去卡：

「闸一开就接人是吧？」他蹲下去看链条和卡齿，「那今晚就先让闸开不了。」

（@Coo：闸的起落机构是什么样的？能卡在哪儿？）`;

const variants = {
  full,
  no_ooc: full.replace(/（@Coo：[\s\S]*?）\s*$/, '').trim(),
  action_only: `宁把手里那只凉箍交给柯林，箍口朝上塞进他布袋：「你拿着，别落地，也别让它见水。」然后他自己转到闸门侧面去找那个起闸的轮子——不是去接，是去卡：「闸一开就接人是吧？」他蹲下去看链条和卡齿，「那今晚就先让闸开不了。」`,
  first_para: `宁把手里那只凉箍交给柯林，箍口朝上塞进他布袋：「你拿着，别落地，也别让它见水。」`,
  second_para: `然后他自己转到闸门侧面去找那个起闸的轮子——不是去接，是去卡：「闸一开就接人是吧？」他蹲下去看链条和卡齿，「那今晚就先让闸开不了。」`,
  ooc_only: `（@Coo：闸的起落机构是什么样的？能卡在哪儿？）`,
};

const prototypes = deserializePrototypes(JSON.parse(fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-prototypes.json', 'utf8')));
const nb = deserializeClassifier(JSON.parse(fs.readFileSync('C:/Users/35794/Documents/DeepSeek\'s Sandbox/coopanion-continuity/backups/continuity-tags-20261031/last100/facet-model.json', 'utf8')));

const out = {};
for (const [name, text] of Object.entries(variants)) {
  const started = Date.now();
  const embedding = await predictEmbedding(prototypes, text);
  const embMs = Date.now() - started;
  const n = predictFacets(nb, text);
  out[name] = {
    chars: [...text].length,
    embedding: embedding.facets,
    confidence: embedding.confidence,
    ms: embMs,
    nb: n.facets,
  };
}
console.log(JSON.stringify(out, null, 2));
