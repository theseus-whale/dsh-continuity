#!/usr/bin/env python3
"""Offline agentPreset rewrite for one DSH session log.

DSH refuses agentPresets.select() after a session has started
("agent-preset/locked"). The durable header is initialized into the
agentPreset projection, so changing it while DSH is stopped is the supported
offline migration path.

STOP DSH BEFORE --apply. The script backs up the original, rewrites only the
first JSON header line, recompresses, and verifies every other line is byte-
identical after decompression.
"""
import argparse
import datetime
import io
import json
import os
import shutil
import sys
import tempfile

import zstandard


def read_lines(path):
    with open(path, 'rb') as fh:
        with zstandard.ZstdDecompressor().stream_reader(fh) as reader:
            with io.TextIOWrapper(reader, encoding='utf-8', newline='') as text:
                return text.readlines()


def write_lines(path, lines):
    data = ''.join(lines).encode('utf-8')
    with open(path, 'wb') as fh:
        fh.write(zstandard.ZstdCompressor(level=3).compress(data))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True, help='session.v4.jsonl.zstd')
    parser.add_argument('--preset', default='continuity')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()

    lines = read_lines(args.file)
    if not lines:
        raise SystemExit('empty session log')
    try:
        header = json.loads(lines[0])
    except Exception as exc:
        raise SystemExit(f'bad header JSON: {exc}')
    old = header.get('agentPreset')
    print('file:', args.file)
    print('lines:', len(lines))
    print('old agentPreset:', old)
    if old == args.preset:
        print('already', args.preset, '- no change')
        return 0
    header['agentPreset'] = args.preset
    new_header = json.dumps(header, ensure_ascii=False, separators=(',', ':')) + '\n'
    if not lines[0].endswith('\n'):
        raise SystemExit('header line has no newline')
    new_lines = [new_header] + lines[1:]

    with tempfile.NamedTemporaryFile(prefix='.preset-', suffix='.zstd', dir=os.path.dirname(args.file), delete=False) as tmp:
        tmp_path = tmp.name
    try:
        write_lines(tmp_path, new_lines)
        check = read_lines(tmp_path)
        if len(check) != len(lines):
            raise SystemExit(f'line count changed: {len(lines)} -> {len(check)}')
        if check[1:] != lines[1:]:
            raise SystemExit('non-header lines changed; refusing')
        print('new agentPreset:', args.preset)
        print('verified lines:', len(check))
        if not args.apply:
            print('dry-run only; add --apply')
            return 0
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup = f'{args.file}.bak-preset-{stamp}'
        shutil.copy2(args.file, backup)
        os.replace(tmp_path, args.file)
        print('backup:', backup)
        print('applied:', args.file)
        return 0
    finally:
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
