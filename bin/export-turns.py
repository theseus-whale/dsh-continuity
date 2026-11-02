#!/usr/bin/env python3
"""Export one DSH session's human prompts as turns.jsonl for rebuild/relabel."""
import argparse
import io
import json
import sys

import zstandard


def text_of(message):
    parts = []
    for block in message.get('content', []):
        if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
            parts.append(block['text'])
    return '\n'.join(parts).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--session-file', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--session-id', default=None)
    args = parser.parse_args()
    turns = {}
    current = None
    with open(args.session_file, 'rb') as fh:
        with zstandard.ZstdDecompressor().stream_reader(fh) as reader:
            text = io.TextIOWrapper(reader, encoding='utf-8')
            for line in text:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                typ = event.get('type')
                if typ == 'session':
                    if args.session_id and event.get('id') != args.session_id:
                        raise SystemExit(f"session id mismatch: {event.get('id')} != {args.session_id}")
                    continue
                if typ == 'turn/start':
                    turn = event.get('data', {}).get('turn')
                    current = turn if isinstance(turn, int) else None
                    continue
                if typ != 'user/message' or current is None:
                    continue
                data = event.get('data', {})
                if data.get('source', {}).get('kind') != 'user':
                    continue
                body = text_of(data)
                if body and current not in turns:
                    turns[current] = body
    with open(args.out, 'w', encoding='utf-8', newline='\n') as out:
        for turn in sorted(turns):
            out.write(json.dumps({'turn': turn, 'text': turns[turn]}, ensure_ascii=False) + '\n')
    print(json.dumps({
        'out': args.out,
        'turns': len(turns),
        'firstTurn': min(turns) if turns else None,
        'lastTurn': max(turns) if turns else None,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
