#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ReLiK reader-only entity linking. Input JSONL: {id,text,candidates:[...]}."""
import json
import os
import sys

from relik import Relik
from relik.reader.pytorch_modules.span import RelikReaderForSpanExtraction

reader_path = os.environ["RELIK_READER"]
reader = RelikReaderForSpanExtraction(reader_path)
relik = Relik(reader=reader, task="span", window_size=32, window_stride=16)

src, out = sys.argv[1], sys.argv[2]
rows = []
for line in open(src, encoding="utf-8"):
    if not line.strip():
        continue
    item = json.loads(line)
    result = relik(item["text"], candidates=item.get("candidates", []))
    spans = [
        {"start": span.start, "end": span.end, "text": span.text, "label": span.label}
        for span in result.spans
    ]
    candidates = result.candidates.span if result.candidates is not None else []
    serial_candidates = []
    for span_group in candidates:
        span_group_out = []
        for candidate_group in span_group:
            span_group_out.append([
                {"text": getattr(doc, "text", None), "id": str(getattr(doc, "id", None))}
                for doc in candidate_group
            ])
        serial_candidates.append(span_group_out)
    rows.append({"id": item.get("id"), "text": item["text"], "spans": spans, "candidates": serial_candidates})
with open(out, "w", encoding="utf-8") as f:
    json.dump({"n": len(rows), "rows": rows}, f, ensure_ascii=False, indent=2)
print(json.dumps({"n": len(rows), "with_spans": sum(1 for row in rows if row["spans"])}, ensure_ascii=False, indent=2))
