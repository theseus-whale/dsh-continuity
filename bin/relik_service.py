#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""One-shot ReLiK reader service: stdin {text,candidates}, stdout {ok, links}."""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from relik import Relik  # noqa: E402
from relik.reader.pytorch_modules.span import RelikReaderForSpanExtraction  # noqa: E402

reader = RelikReaderForSpanExtraction(os.environ["RELIK_READER"])
relik = Relik(reader=reader, task="span", window_size=32, window_stride=16)

def handle(request):
    if request.get("health"):
        return {"ok": True, "health": "ready"}
    try:
        result = relik(str(request.get("text", "")), candidates=request.get("candidates") or [])
        links = []
        candidate_groups = result.candidates.span if result.candidates is not None else []
        for index, span in enumerate(result.spans):
            group = []
            if candidate_groups and index < len(candidate_groups) and candidate_groups[index]:
                group = candidate_groups[index][0]
            elif candidate_groups and candidate_groups[0]:
                group = candidate_groups[0][0]
            top = next((candidate for candidate in group if candidate.text in (span.label, span.text)), group[0] if group else None)
            links.append({
                "text": span.text,
                "entityId": str(top.id) if top is not None else None,
                "score": None,
                "start": span.start,
                "end": span.end,
            })
        return {"ok": True, "links": links, "spans": [{"text": s.text, "start": s.start, "end": s.end} for s in result.spans]}
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
