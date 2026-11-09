#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Chinese NER benchmark: UER CLUENER model on clean CLUE-NER validation."""
import json
import sys
import torch
from datasets import load_dataset
from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

MODEL = "uer/roberta-base-finetuned-cluener2020-chinese"
DATASET = "xusenlin/clue-ner"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 100
OUT = sys.argv[2] if len(sys.argv) > 2 else None

torch.set_num_threads(1)
print("loading model", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForTokenClassification.from_pretrained(MODEL)
print("labels", model.config.id2label, flush=True)
ner = pipeline("ner", model=model, tokenizer=tok, aggregation_strategy="simple", device=-1, truncation=True, max_length=512)
print("loading data", flush=True)
ds = load_dataset(DATASET, split="validation")


def spans(pred, gold):
    gold_keys = {(g["entity"], g["label"]) for g in gold}
    pred_keys = {(p["word"].replace(" ", ""), p["entity_group"]) for p in pred}
    tp = len(gold_keys & pred_keys)
    fp = len(pred_keys - gold_keys)
    fn = len(gold_keys - pred_keys)
    precision = 0 if not pred_keys else tp / len(pred_keys)
    recall = 0 if not gold_keys else tp / len(gold_keys)
    f1 = 0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


rows = []
for i in range(min(LIMIT, len(ds))):
    item = ds[i]
    pred = ner(item["text"])
    gold = [{"entity": e["entity"], "label": e["label"]} for e in item["entities"]]
    rows.append({
        "text": item["text"],
        "pred": [{"text": p["word"].replace(" ", ""), "label": p["entity_group"]} for p in pred],
        "gold": gold,
    })
    if i < 2:
        print("sample", i, rows[-1]["pred"], rows[-1]["gold"], flush=True)

result = {
    "model": MODEL,
    "dataset": DATASET,
    "n": len(rows),
    "score": spans([p for r in rows for p in r["pred"]], [g for r in rows for g in r["gold"]]),
    "rows": rows,
}
if OUT:
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False, indent=2), flush=True)
