#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Direct token-classification inference, no transformers pipeline."""
import json
import sys
import time

import torch
from datasets import load_dataset
from transformers import AutoModelForTokenClassification, AutoTokenizer

MODEL = "uer/roberta-base-finetuned-cluener2020-chinese"
DATASET = "xusenlin/clue-ner"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 20
OUT = sys.argv[2] if len(sys.argv) > 2 else None
MAX_LEN = 256

torch.set_num_threads(1)
print("load tokenizer", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
print("fast", tok.is_fast, flush=True)
model = AutoModelForTokenClassification.from_pretrained(MODEL)
model.eval()
id2label = model.config.id2label
print("load data", flush=True)
ds = load_dataset(DATASET, split="validation")


def predict(text):
    enc = tok(text, return_tensors="pt", truncation=True, max_length=MAX_LEN, return_offsets_mapping=tok.is_fast)
    offsets = enc.pop("offset_mapping")[0].tolist()
    with torch.no_grad():
        logits = model(**enc).logits[0]
    ids = logits.argmax(-1).tolist()
    entities = []
    current = None
    for idx, label_id in enumerate(ids):
        label = id2label[int(label_id)]
        start, end = offsets[idx]
        if start == end:
            continue
        if label == "O":
            if current is not None:
                entities.append(current)
                current = None
            continue
        prefix, _, kind = label.partition("-")
        if prefix == "S":
            if current is not None:
                entities.append(current)
                current = None
            entities.append({"text": text[start:end], "label": kind, "start": start, "end": end})
        elif prefix == "B":
            if current is not None:
                entities.append(current)
            current = {"text": text[start:end], "label": kind, "start": start, "end": end}
        elif prefix in ("I", "E") and current is not None:
            current["text"] += text[start:end]
            current["end"] = end
            if prefix == "E":
                entities.append(current)
                current = None
    if current is not None:
        entities.append(current)
    return entities


def score(pred, gold):
    gold_keys = {(g["entity"], g["label"]) for g in gold}
    pred_keys = {(p["text"].replace(" ", ""), p["label"]) for p in pred}
    tp = len(gold_keys & pred_keys)
    fp = len(pred_keys - gold_keys)
    fn = len(gold_keys - pred_keys)
    precision = 0 if not pred_keys else tp / len(pred_keys)
    recall = 0 if not gold_keys else tp / len(gold_keys)
    f1 = 0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


rows = []
for i in range(min(LIMIT, len(ds))):
    print("sample", i, flush=True)
    item = ds[i]
    t0 = time.time()
    pred = predict(item["text"])
    gold = [{"entity": e["entity"], "label": e["label"]} for e in item["entities"]]
    rows.append({"text": item["text"], "pred": pred, "gold": gold})
    print("done", i, round(time.time() - t0, 2), pred[:3], flush=True)

result = {
    "model": MODEL,
    "dataset": DATASET,
    "n": len(rows),
    "score": score([p for r in rows for p in r["pred"]], [g for r in rows for g in r["gold"]]),
    "rows": rows,
}
if OUT:
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False, indent=2), flush=True)
