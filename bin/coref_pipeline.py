#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Coreference pipeline using coreferee. Input JSONL: {id,text}. Output clusters."""
import json
import sys

import spacy
import coreferee

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
            start_token = min(token_indexes)
            end_token = max(token_indexes) + 1
            span = doc[start_token:end_token]
            mentions.append({
                "text": span.text,
                "start": span.start_char,
                "end": span.end_char,
                "isCanonical": index == chain.most_specific_mention_index,
            })
        if mentions:
            out.append({"mentions": mentions})
    return out


src, out = sys.argv[1], sys.argv[2]
rows = []
for line in open(src, encoding="utf-8"):
    if not line.strip():
        continue
    item = json.loads(line)
    rows.append({"id": item.get("id"), "text": item["text"], "clusters": clusters_for(item["text"])})
with open(out, "w", encoding="utf-8") as f:
    json.dump({"n": len(rows), "rows": rows}, f, ensure_ascii=False, indent=2)
print(json.dumps({"n": len(rows), "with_clusters": sum(1 for r in rows if r["clusters"])}, ensure_ascii=False, indent=2))
