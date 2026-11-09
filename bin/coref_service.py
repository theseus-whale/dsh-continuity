#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""One-shot coreference service: stdin {text}, stdout {ok, clusters}."""
import json
import sys

import coreferee
import spacy

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

nlp = spacy.load("en_core_web_sm")
nlp.add_pipe("coreferee")


def clusters_for(text):
    doc = nlp(text)
    out = []
    for chain in doc._.coref_chains:
        mentions = []
        for index in range(len(chain)):
            mention = chain[index]
            token_indexes = list(mention.token_indexes)
            if not token_indexes:
                continue
            span = doc[min(token_indexes):max(token_indexes) + 1]
            mentions.append({
                "text": span.text,
                "start": span.start_char,
                "end": span.end_char,
                "isCanonical": index == chain.most_specific_mention_index,
            })
        if mentions:
            out.append({"mentions": mentions})
    return out


def handle(request):
    if request.get("health"):
        return {"ok": True, "health": "ready"}
    try:
        return {"ok": True, "clusters": clusters_for(str(request.get("text", "")))}
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
