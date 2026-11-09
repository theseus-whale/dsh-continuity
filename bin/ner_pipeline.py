#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Bilingual NER pipeline over local JSONL messages. No training, no live IO."""
import json
import re
import sys

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

ZH_MODEL = "uer/roberta-base-finetuned-cluener2020-chinese"
EN_MODEL = "elastic/distilbert-base-uncased-finetuned-conll03-english"
MAX_LEN = 256

ZH_SLOT = {
    "name": "characters",
    "address": "location",
    "scene": "location",
    "company": "objects",
    "organization": "objects",
    "government": "objects",
    "book": "objects",
    "movie": "objects",
    "game": "objects",
}
EN_SLOT = {"PER": "characters", "LOC": "location", "ORG": "objects", "MISC": "objects", "PROPER": "objects"}
PROPER_STOP = {
    "The", "This", "That", "These", "Those", "If", "Then", "There", "Here",
    "We", "You", "I", "It", "He", "She", "They", "But", "And", "Or", "So",
    "DSH", "TAG", "CPU", "GPU", "API", "JSON", "HTML", "HTTP", "HTTPS",
}

torch.set_num_threads(1)
print("load zh", flush=True)
zh_tok = AutoTokenizer.from_pretrained(ZH_MODEL)
zh_model = AutoModelForTokenClassification.from_pretrained(ZH_MODEL)
zh_model.eval()
print("load en", flush=True)
en_tok = AutoTokenizer.from_pretrained(EN_MODEL)
en_model = AutoModelForTokenClassification.from_pretrained(EN_MODEL)
en_model.eval()
print("models ready", flush=True)


def route(text):
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    return "en" if cjk == 0 and latin > 0 else "zh"


def decode(text, offsets, ids, id2label, mode):
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
        if mode == "zh":
            if prefix == "S":
                if current is not None:
                    entities.append(current)
                entities.append({"text": text[start:end], "label": kind, "start": start, "end": end})
                current = None
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
        else:
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
    if mode == "en":
        merged = []
        for entity in entities:
            last = merged[-1] if merged else None
            if last is not None and last["label"] == entity["label"] and entity["start"] - last["end"] <= 1:
                last["text"] += entity["text"]
                last["end"] = entity["end"]
            else:
                merged.append(entity)
        entities = merged
    return entities


def infer(tok, model, text, mode):
    enc = tok(text, return_tensors="pt", truncation=True, max_length=MAX_LEN, return_offsets_mapping=True)
    offsets = enc.pop("offset_mapping")[0].tolist()
    with torch.no_grad():
        logits = model(**enc).logits[0]
    return decode(text, offsets, logits.argmax(-1).tolist(), model.config.id2label, mode)


def extract(text):
    lang = route(text)
    zh_entities = infer(zh_tok, zh_model, text, "zh")
    en_entities = infer(en_tok, en_model, text, "en")
    combined = []
    seen = set()
    for entity in en_entities:
        entity_text = entity["text"]
        if any(c.isascii() and c.isalpha() for c in entity_text):
            key = (entity["start"], entity["end"], entity_text)
            if key not in seen:
                seen.add(key)
                combined.append(entity)
    for entity in zh_entities:
        entity_text = entity["text"]
        if not any(c.isascii() and c.isalpha() for c in entity_text):
            key = (entity["start"], entity["end"], entity_text)
            if key not in seen:
                seen.add(key)
                combined.append(entity)
    combined.sort(key=lambda item: (item["start"], item["end"]))
    merged = []
    for entity in combined:
        last = merged[-1] if merged else None
        if last is not None and entity["start"] <= last["end"] + 1:
            between = text[last["end"]:entity["start"]]
            both_latin = all(any(c.isascii() and c.isalpha() for c in item["text"]) for item in (last, entity))
            if both_latin and between.strip() == "":
                last["text"] = text[last["start"]:entity["end"]]
                last["end"] = entity["end"]
                if last["label"] not in ("PER", "PERSON", "name"):
                    last["label"] = entity["label"] if entity["label"] in ("PER", "PERSON", "name") else last["label"]
                continue
        merged.append(entity)
    combined = merged
    existing_spans = [(item["start"], item["end"], item) for item in combined]
    for match in re.finditer(r"(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9_-]{1,20}(?![A-Za-z0-9_])", text):
        token = match.group(0)
        if token in PROPER_STOP:
            continue
        span = (match.start(), match.end())
        overlap = next(((start, end, item) for start, end, item in existing_spans if start < span[1] and span[0] < end), None)
        if overlap is not None:
            if overlap[0] == span[0] and len(token) > len(overlap[2]["text"]):
                combined.remove(overlap[2])
                combined.append({"text": token, "label": "PROPER", "start": span[0], "end": span[1]})
                existing_spans = [(item["start"], item["end"], item) for item in combined]
            continue
        combined.append({"text": token, "label": "PROPER", "start": span[0], "end": span[1]})
        existing_spans.append((span[0], span[1], combined[-1]))
    combined.sort(key=lambda item: (item["start"], item["end"]))
    ANIMATE = re.compile(r"(?:说|问|答|看|听|想|做|装|退|关|备份|运行|她|他|你|我)")
    PRODUCT = re.compile(r"(?:插件|版本|系统|模型|工具|平台|接口|文件|世界|规则|框架|协议|功能)")
    for entity in combined:
        if entity["label"] != "PROPER":
            continue
        context = text[max(0, entity["start"] - 10):min(len(text), entity["end"] + 10)]
        if ANIMATE.search(context) and not PRODUCT.search(context):
            entity["label"] = "PER"
    slot_map = {}
    slot_map.update(ZH_SLOT)
    slot_map.update(EN_SLOT)
    slots = {"characters": [], "location": None, "objects": []}
    for entity in combined:
        slot = slot_map.get(entity["label"])
        if slot == "characters":
            slots["characters"].append(entity["text"])
        elif slot == "location" and slots["location"] is None:
            slots["location"] = entity["text"]
        elif slot == "objects":
            slots["objects"].append(entity["text"])
    slots["characters"] = list(dict.fromkeys(slots["characters"]))
    slots["objects"] = list(dict.fromkeys(slots["objects"]))
    slots["objects"] = [item for item in slots["objects"] if item not in slots["characters"]]
    return {"lang": lang, "entities": combined, "slots": slots}


src, out, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 100
rows = []
for line in open(src, encoding="utf-8"):
    if len(rows) >= limit:
        break
    item = json.loads(line)
    text = item.get("text", "")
    if not text.strip():
        continue
    rows.append({"turn": item.get("turn"), "text": text, **extract(text)})
    if len(rows) % 10 == 0:
        print("done", len(rows), flush=True)

with open(out, "w", encoding="utf-8") as f:
    json.dump({"n": len(rows), "rows": rows}, f, ensure_ascii=False, indent=2)
print(json.dumps({"n": len(rows), "langs": {k: sum(1 for r in rows if r["lang"] == k) for k in ["zh", "en"]}, "with_entities": sum(1 for r in rows if r["entities"])}, ensure_ascii=False, indent=2), flush=True)
