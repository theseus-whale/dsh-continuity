#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""One-shot SRL service: stdin {text}, stdout {ok, srl}."""
import json
import os
import sys

import nltk
import spacy

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def add_pos(doc):
    tags = nltk.pos_tag([token.text for token in doc])
    for token, (_, tag) in zip(doc, tags):
        token.tag_ = tag
        if tag.startswith("VB"):
            token.pos_ = "VERB"
        elif tag.startswith("NN"):
            token.pos_ = "NOUN"
        elif tag.startswith("JJ"):
            token.pos_ = "ADJ"
        elif tag.startswith("RB"):
            token.pos_ = "ADV"
        elif tag in ("IN", "TO"):
            token.pos_ = "ADP"
        elif tag in ("DT", "PRP", "PRP$"):
            token.pos_ = "DET"
        else:
            token.pos_ = "X"
    return doc


blank = spacy.blank("en")
blank.add_pipe(add_pos)
spacy.load = lambda *args, **kwargs: blank

import transformer_srl.dataset_readers  # noqa: E402,F401
import transformer_srl.models  # noqa: E402,F401
from allennlp.models.archival import load_archive  # noqa: E402
from transformer_srl import predictors  # noqa: E402

archive = load_archive(os.environ["SRL_ARCHIVE"])
predictor = predictors.SrlTransformersPredictor.from_archive(archive, "transformer_srl")

def handle(request):
    if request.get("health"):
        return {"ok": True, "health": "ready"}
    try:
        result = predictor.predict(sentence=str(request.get("text", "")))
        verb = result["verbs"][0] if result["verbs"] else None
        return {"ok": True, "srl": {"words": result["words"], "verb": verb}}
    except Exception as error:
        return {"ok": False, "reason": type(error).__name__, "message": str(error)[:300]}


if "--serve" in sys.argv:
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        request = json.loads(line)
        print(json.dumps({"id": request.get("id"), **handle(request)}, ensure_ascii=False), flush=True)
else:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    print(json.dumps(handle(request), ensure_ascii=False))
