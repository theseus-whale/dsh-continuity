# -*- coding: utf-8 -*-
import json
import sys
from collections import Counter

data = json.load(open(sys.argv[1], encoding="utf-8"))
rows = data["rows"]
fp = []
fn = []
gold_count = Counter()
pred_count = Counter()
for row in rows:
    gold = {(g["text"].replace(" ", ""), g["label"]) for g in row["gold"]}
    pred = {(p["text"].replace(" ", ""), p["label"]) for p in row["pred"]}
    for _, label in gold:
        gold_count[label] += 1
    for _, label in pred:
        pred_count[label] += 1
    for text, label in pred - gold:
        fp.append({"text": text, "label": label, "sentence": row["text"]})
    for text, label in gold - pred:
        fn.append({"text": text, "label": label, "sentence": row["text"]})
summary = {
    "score": data["score"],
    "gold_by_label": dict(gold_count),
    "pred_by_label": dict(pred_count),
    "fp_by_label": dict(Counter(x["label"] for x in fp)),
    "fn_by_label": dict(Counter(x["label"] for x in fn)),
    "fp_samples": fp[:30],
    "fn_samples": fn[:30],
}
json.dump(summary, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in summary.items() if not k.endswith("samples")}, ensure_ascii=False, indent=2))
