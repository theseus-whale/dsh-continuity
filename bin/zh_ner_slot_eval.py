# -*- coding: utf-8 -*-
import json
import sys

MAP = {
    "name": "PERSON",
    "address": "PLACE",
    "scene": "PLACE",
    "company": "ORG",
    "organization": "ORG",
    "government": "ORG",
    "book": "WORK",
    "movie": "WORK",
    "game": "WORK",
    "position": "ROLE",
}


def coarse(label):
    return MAP.get(label, label)


data = json.load(open(sys.argv[1], encoding="utf-8"))
tp = fp = fn = 0
for row in data["rows"]:
    gold = {(g["entity"], coarse(g["label"])) for g in row["gold"]}
    pred = {(p["text"].replace(" ", ""), coarse(p["label"])) for p in row["pred"]}
    tp += len(gold & pred)
    fp += len(pred - gold)
    fn += len(gold - pred)
precision = 0 if tp + fp == 0 else tp / (tp + fp)
recall = 0 if tp + fn == 0 else tp / (tp + fn)
f1 = 0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
print(json.dumps({
    "n": data["n"],
    "exact_label_f1": data["score"]["f1"],
    "coarse_slot": {"tp": tp, "fp": fp, "fn": fn, "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)},
}, ensure_ascii=False, indent=2))
