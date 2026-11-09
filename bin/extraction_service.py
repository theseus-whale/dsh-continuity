#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""One-shot extraction service: stdin {text}, stdout {ok, lang, entities, slots}."""
import json
import os
import sys

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ZH_MODEL = os.environ.get("ZH_MODEL_DIR", "uer/roberta-base-finetuned-cluener2020-chinese")
EN_MODEL = os.environ.get("EN_MODEL_DIR", "elastic/distilbert-base-uncased-finetuned-conll03-english")
ZH_SLOT = {
    "name": "characters", "address": "location", "scene": "location",
    "company": "objects", "organization": "objects", "government": "objects",
    "book": "objects", "movie": "objects", "game": "objects",
}
EN_SLOT = {"PER": "characters", "LOC": "location", "ORG": "objects", "MISC": "objects"}

torch.set_num_threads(1)
zh_tok = AutoTokenizer.from_pretrained(ZH_MODEL)
zh_model = AutoModelForTokenClassification.from_pretrained(ZH_MODEL, local_files_only=True, use_safetensors=False)
zh_model.eval()
en_tok = AutoTokenizer.from_pretrained(EN_MODEL)
en_model = AutoModelForTokenClassification.from_pretrained(EN_MODEL, local_files_only=True, use_safetensors=False)
en_model.eval()


def route(text):
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    return "en" if cjk == 0 and latin > 0 else "zh"


def infer(tok, model, text, mode):
    enc = tok(text, return_tensors="pt", truncation=True, max_length=256, return_offsets_mapping=True)
    offsets = enc.pop("offset_mapping")[0].tolist()
    with torch.no_grad():
        ids = model(**enc).logits[0].argmax(-1).tolist()
    if os.environ.get("DEBUG_EXTRACTION"):
        global DEBUG_LAST
        DEBUG_LAST = {
            "tokens": tok.convert_ids_to_tokens(enc["input_ids"][0])[:12],
            "pred": [model.config.id2label[int(i)] for i in ids[:12]],
        }
    entities = []
    current = None
    for idx, label_id in enumerate(ids):
        label = model.config.id2label[int(label_id)]
        start, end = offsets[idx]
        if start == end:
            continue
        if label == "O":
            if current:
                entities.append(current)
                current = None
            continue
        prefix, _, kind = label.partition("-")
        if mode == "zh":
            if prefix == "S":
                if current:
                    entities.append(current)
                entities.append({"text": text[start:end], "label": kind, "start": start, "end": end})
                current = None
            elif prefix == "B":
                if current:
                    entities.append(current)
                current = {"text": text[start:end], "label": kind, "start": start, "end": end}
            elif prefix in ("I", "E") and current:
                current["text"] += text[start:end]
                current["end"] = end
                if prefix == "E":
                    entities.append(current)
                    current = None
        else:
            if prefix == "B":
                if current:
                    entities.append(current)
                current = {"text": text[start:end], "label": kind, "start": start, "end": end}
            elif prefix == "I" and current and current["label"] == kind:
                current["text"] += text[start:end]
                current["end"] = end
            else:
                if current:
                    entities.append(current)
                current = {"text": text[start:end], "label": kind, "start": start, "end": end}
    if current:
        entities.append(current)
    if mode == "en":
        merged = []
        for entity in entities:
            last = merged[-1] if merged else None
            if last and last["label"] == entity["label"] and entity["start"] - last["end"] <= 1:
                last["text"] += entity["text"]
                last["end"] = entity["end"]
            else:
                merged.append(entity)
        entities = merged
    return entities


def extract(text):
    lang = route(text)
    zh_entities = infer(zh_tok, zh_model, text, "zh")
    en_entities = infer(en_tok, en_model, text, "en")
    if os.environ.get("DEBUG_EXTRACTION"):
        print("DEBUG", repr(text[:20]), zh_model.config.id2label, zh_entities[:3], file=sys.stderr)
    combined = []
    seen = set()
    for entity in en_entities:
        if any(c.isascii() and c.isalpha() for c in entity["text"]):
            key = (entity["start"], entity["end"], entity["text"])
            if key not in seen:
                seen.add(key)
                combined.append(entity)
    for entity in zh_entities:
        if not any(c.isascii() and c.isalpha() for c in entity["text"]):
            key = (entity["start"], entity["end"], entity["text"])
            if key not in seen:
                seen.add(key)
                combined.append(entity)
    combined.sort(key=lambda item: (item["start"], item["end"]))
    slot_map = {**ZH_SLOT, **EN_SLOT}
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
    debug = None
    if os.environ.get("DEBUG_EXTRACTION"):
        debug = {"text": text[:40], "zh_entities": zh_entities[:5], "labels": [zh_model.config.id2label[i] for i in range(4)], "last": DEBUG_LAST}
    return {"lang": lang, "entities": combined, "slots": slots, "debug": debug}


def handle(request):
    if request.get("health"):
        return {"ok": True, "health": "ready", "langs": ["zh", "en"]}
    try:
        return {"ok": True, **extract(str(request.get("text", "")))}
    except Exception as error:
        return {"ok": False, "reason": type(error).__name__, "message": str(error)[:300]}


if "--serve" in sys.argv:
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        request = json.loads(line)
        result = {"id": request.get("id"), **handle(request)}
        print(json.dumps(result, ensure_ascii=False), flush=True)
else:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    print(json.dumps(handle(request), ensure_ascii=False))
