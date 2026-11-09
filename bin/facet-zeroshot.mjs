import { embedTexts } from '../src/facets/embedding.mjs';

const keywords = ['COVID-19', '实验室泄漏', '自然宿主', '冷链传播'];
const labels = ['病毒', '疫情', '公共卫生', '技术', '设备', '剧情', '其他'];
const vectors = await embedTexts([...keywords, ...labels]);
const k = vectors.slice(0, keywords.length);
const l = vectors.slice(keywords.length);
const cos = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const rows = labels.map((label, i) => ({
  label,
  score: k.reduce((sum, vec) => sum + cos(vec, l[i]), 0) / k.length,
  per: Object.fromEntries(keywords.map((word, j) => [word, Number(cos(k[j], l[i]).toFixed(3))])),
})).sort((a, b) => b.score - a.score);
console.log(JSON.stringify(rows, null, 2));
