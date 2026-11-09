#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""English NER benchmark: DistilBERT CoNLL03 on the official eng.testa file."""
import json
import sys

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

MODEL = "elastic/distilbert-base-uncased-finetuned-conll03-english"
FILE = sys.argv[1]
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 200
OUT = sys.argv[3] if len(sys.argv) > 3 else None
MAX_LEN = 256

torch.set_num_threads(1)
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForTokenClassification.from_pretrained(MODEL)
model.eval()
id2label = model.config.id2label


def read_sentences(path):
    sentences = []
    tokens, tags = [], []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line.strip():
            if tokens:
                sentences.append((tokens, tags))
                tokens, tags = [], []
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        tokens.append(parts[0])
        tags.append(parts[-1])
    if tokens:
        sentences.append((tokens, tags))
    return sentences


def predict(text):
    enc = tok(text, return_tensors="pt", truncation=True, max_length=MAX_LEN, return_offsets_mapping=True)
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
    merged = []
    for entity in entities:
        last = merged[-1] if merged else None
        if last is not None and last["label"] == entity["label"] and entity["start"] - last["end"] <= 1:
            last["text"] += entity["text"]
            last["end"] = entity["end"]
        else:
            merged.append(entity)
    return merged


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


sentences = read_sentences(FILE)[:LIMIT]
rows = []
for i, (tokens, tags) in enumerate(sentences):
    text = " ".join(tokens)
    rows.append({"text": text, "pred": predict(text), "gold": gold_entities(tokens, tags)})

result = {
    "model": MODEL,
    "dataset": "CoNLL2003 eng.testa",
    "n": len(rows),
    "score": score([p for r in rows for p in r["pred"]], [g for r in rows for g in r["gold"]]),
    "rows": rows,
}
if OUT:
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False, indent=2))
