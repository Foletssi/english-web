"""Normalize a completed candidate's source uncertainty without new AI requests.

Writes a separate local file; never edits running process output or cloud data.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/local-studio'))
from teaching_details import finalize_source_status


def finalize(source, candidate):
    rows = [dict(row) for row in source['sentences']]
    draft = {row['id']: row for row in source.get('draftSentences', [])}
    for row in rows:
        locked = draft.get(row['id'], {})
        if locked.get('translationLocked'):
            if locked.get('english') != row.get('english'):
                raise ValueError('Locked draft differs from published source')
            if row.get('translationLocked') and row.get('chinese') != locked.get('chinese'):
                raise ValueError('Locked translations disagree')
            row['chinese'] = locked.get('chinese', '')
    return {**candidate, 'sentences': finalize_source_status(candidate['sentences'], rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--candidates', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in (args.source.resolve(), args.candidates.resolve()):
        raise ValueError('Output must not replace source or running candidates')
    source = json.loads(args.source.read_text(encoding='utf-8'))
    candidate = json.loads(args.candidates.read_text(encoding='utf-8'))
    result = finalize(source, candidate)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    unresolved = sum(row['translationAnalysis']['status'] == 'source_unresolved' for row in result['sentences'])
    print(json.dumps({'sentences': len(result['sentences']), 'sourceUnresolved': unresolved,
                      'aiRequests': 0, 'cloudWrites': 0}))


if __name__ == '__main__':
    main()
