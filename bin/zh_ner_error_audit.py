# -*- coding: utf-8 -*-
import json
import sys
from collections import Counter

src, out = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
rows = data["rows"]
gold_count = Counter()
pred_count = Counter()
fp = []
fn = []
for row in rows:
    gold = {(g["entity"], g["label"]) for g in row["gold"]}
    pred = {(p["text"].replace(" ", ""), p["label"]) for p in row["pred"]}
    for item in gold:
        gold_count[item[1]] += 1
    for item in pred:
        pred_count[item[1]] += 1
    for item in pred - gold:
        fp.append({"text": item[0], "label": item[1], "sentence": row["text"]})
    for item in gold - pred:
        fn.append({"text": item[0], "label": item[1], "sentence": row["text"]})

summary = {
    "n": data["n"],
    "score": data["score"],
    "gold_by_label": dict(gold_count),
    "pred_by_label": dict(pred_count),
    "fp_by_label": dict(Counter(x["label"] for x in fp)),
    "fn_by_label": dict(Counter(x["label"] for x in fn)),
    "fp_samples": fp[:20],
    "fn_samples": fn[:20],
}
json.dump(summary, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in summary.items() if not k.endswith("samples")}, ensure_ascii=False, indent=2))
