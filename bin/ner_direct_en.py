#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""English NER benchmark: DistilBERT CoNLL03 on CoNLL2003 validation."""
import json
import sys

import torch
from datasets import load_dataset
from transformers import AutoModelForTokenClassification, AutoTokenizer

MODEL = "elastic/distilbert-base-uncased-finetuned-conll03-english"
DATASET = "jon-fernandes/conll2003"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 200
OUT = sys.argv[2] if len(sys.argv) > 2 else None
MAX_LEN = 256

torch.set_num_threads(1)
print("tokenizer", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
print("model", flush=True)
model = AutoModelForTokenClassification.from_pretrained(MODEL)
model.eval()
id2label = model.config.id2label
print("data", flush=True)
ds = load_dataset(DATASET, split="validation")
print("data ok", len(ds), flush=True)


def decode(text, offsets, ids):
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
        if prefix == "B":
            if current is not None:
                entities.append(current)
            current = {"text": text[start:end], "label": kind, "start": start, "end": end}
        elif prefix == "I" and current is not None and current["label"] == kind:
            current["text"] += text[start:end]
            current["end"] = end
        else:
            if current is not None:
                entities.append(current)
            current = {"text": text[start:end], "label": kind, "start": start, "end": end}
    if current is not None:
        entities.append(current)
    return entities


def predict(text):
    enc = tok(text, return_tensors="pt", truncation=True, max_length=MAX_LEN, return_offsets_mapping=True)
    offsets = enc.pop("offset_mapping")[0].tolist()
    with torch.no_grad():
        logits = model(**enc).logits[0]
    return decode(text, offsets, logits.argmax(-1).tolist())


def gold_entities(tokens, tags):
    out = []
    current = None
    for token, tag in zip(tokens, tags):
        if tag == "O":
            if current is not None:
                out.append(current)
                current = None
            continue
        prefix, _, kind = tag.partition("-")
        if prefix == "B":
            if current is not None:
                out.append(current)
            current = {"text": token, "label": kind}
        elif prefix == "I" and current is not None:
            current["text"] += " " + token
        else:
            if current is not None:
                out.append(current)
            current = {"text": token, "label": kind}
    if current is not None:
        out.append(current)
    return out


def score(pred, gold):
    pred_keys = {(p["text"].replace(" ", ""), p["label"]) for p in pred}
    gold_keys = {(g["text"].replace(" ", ""), g["label"]) for g in gold}
    tp = len(pred_keys & gold_keys)
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
    text = " ".join(item["tokens"])
    pred = predict(text)
    gold = gold_entities(item["tokens"], item["ner_tags"])
    rows.append({"text": text, "pred": pred, "gold": gold})

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
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False, indent=2))
