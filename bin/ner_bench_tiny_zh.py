#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Tiny local Chinese NER smoke benchmark on CLUE-NER validation (boundary-only)."""
import json
import os
import sys
from datasets import load_dataset
from tokenizers import BertWordPieceTokenizer
from transformers import AutoModelForTokenClassification, PreTrainedTokenizerFast, pipeline

MODEL_DIR = os.path.join(os.environ["TEMP"], "ckip-tiny")
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 20
OUT = sys.argv[2] if len(sys.argv) > 2 else None

bw = BertWordPieceTokenizer(vocab=os.path.join(MODEL_DIR, "vocab.txt"), lowercase=False)
tok = PreTrainedTokenizerFast(
    tokenizer_object=bw,
    unk_token="[UNK]",
    sep_token="[SEP]",
    pad_token="[PAD]",
    cls_token="[CLS]",
    mask_token="[MASK]",
)
model = AutoModelForTokenClassification.from_pretrained(MODEL_DIR)
ner = pipeline("ner", model=model, tokenizer=tok, aggregation_strategy="simple", device=-1)
ds = load_dataset("xusenlin/clue-ner", split="validation")

rows = []
tp = fp = fn = 0
for i in range(min(LIMIT, len(ds))):
    item = ds[i]
    pred = ner(item["text"])
    pred_spans = {p["word"].replace(" ", "") for p in pred}
    gold_spans = {e["entity"] for e in item["entities"]}
    tp += len(pred_spans & gold_spans)
    fp += len(pred_spans - gold_spans)
    fn += len(gold_spans - pred_spans)
    rows.append({
        "text": item["text"],
        "pred": [{"text": p["word"].replace(" ", ""), "label": p["entity_group"]} for p in pred],
        "gold": [{"text": e["entity"], "label": e["label"]} for e in item["entities"]],
        "pred_spans": sorted(pred_spans),
        "gold_spans": sorted(gold_spans),
    })
precision = 0 if tp + fp == 0 else tp / (tp + fp)
recall = 0 if tp + fn == 0 else tp / (tp + fn)
f1 = 0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
result = {
    "model": "ckiplab/bert-tiny-chinese-ner (local)",
    "dataset": "xusenlin/clue-ner validation",
    "n": len(rows),
    "boundary_only": {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)},
    "rows": rows,
}
if OUT:
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False, indent=2))

