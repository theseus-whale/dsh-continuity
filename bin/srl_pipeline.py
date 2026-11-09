#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""SRL pipeline: transformer-srl + local CoNLL2012 archive + NLTK POS fallback."""
import json
import os
import sys

import nltk
import spacy


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

src, out = sys.argv[1], sys.argv[2]
rows = []
for line in open(src, encoding="utf-8"):
    if not line.strip():
        continue
    item = json.loads(line)
    result = predictor.predict(sentence=item["text"])
    rows.append({"id": item.get("id"), "text": item["text"], **result})
with open(out, "w", encoding="utf-8") as f:
    json.dump({"n": len(rows), "rows": rows}, f, ensure_ascii=False, indent=2)
print(json.dumps({"n": len(rows), "with_verbs": sum(1 for row in rows if row["verbs"])}, ensure_ascii=False, indent=2))
