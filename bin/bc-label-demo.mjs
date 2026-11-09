import { embedTexts } from '../src/facets/embedding.mjs';
import { createBLabeler } from '../src/memory/bc-label.mjs';

const labeler = createBLabeler({ embed: embedTexts });
for (const text of [
  '我把七把钥匙收进兜里，走到门口，用鞋尖量了量潮线到船位的距离。',
  '我昨天看了COVID-19的起源报告，病毒可能来自实验室泄漏，也提到自然宿主和冷链传播。',
  '我们接下来去跑团吧。',
  '帮我看一下这个函数的 bug。',
]) {
  const result = await labeler.label(text);
  console.log(JSON.stringify({
    text: text.slice(0, 40),
    top: result.top,
    candidates: result.candidates,
    unknown: result.unknown,
  }, null, 2));
}
