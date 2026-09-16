"""Generate review-only DeepSeek candidates against current published sentences.

No database writes or automatic approvals. The saved source is the concurrency
guard for a later, separately reviewed field-only publication.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/local-studio'))
from ai_tools import repair_learning
from teaching_prompts import TEACHING_PROMPT_VERSION

spec = importlib.util.spec_from_file_location('catalog_refresh', ROOT / 'scripts/refresh-catalog-assets.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


def main(args):
    rows = catalog.query(args.cli, "select revision,published,draft from private.content_snapshots where environment='production'")
    source = rows[0]
    video_id = args.video
    video = next(v for v in source['published']['videos'] if str(v['id']) == video_id)
    published = source['published']['sentences'][video_id]
    draft = source['draft']['sentences'].get(video_id, [])
    draft_by_id = {str(s['id']): s for s in draft}
    inputs = []
    for sentence in published:
        edited = draft_by_id.get(str(sentence['id']))
        current = dict(sentence)
        if edited and edited.get('selectionLocked'):
            if edited.get('english') != sentence.get('english'):
                raise RuntimeError('Locked draft sentence differs from published source; review manually')
            current.update({k: edited[k] for k in ('selectionLocked', 'keyWords', 'expressions') if k in edited})
        inputs.append(current)
    saved = {'revision': source['revision'], 'video': video, 'sentences': published, 'draftSentences': draft,
             'promptVersion': TEACHING_PROMPT_VERSION}
    args.output.mkdir(parents=True, exist_ok=True)
    path = args.output / 'source.json'
    if path.exists() and json.loads(path.read_text(encoding='utf-8')) != saved:
        raise RuntimeError('Prepared source changed; use a new directory and review again')
    catalog.save(path, saved)
    config = {'apiKey': os.environ['DEEPSEEK_API_KEY'], 'baseUrl': os.getenv('DEEPSEEK_BASE_URL'),
              'model': os.getenv('AI_DEEPSEEK_TRANSLATE_MODEL')}
    def progress(stage, percent, message, **kwargs):
        print(json.dumps({'videoId': video_id, 'percent': percent, 'batch': kwargs.get('current'),
                          'total': kwargs.get('total')}, ensure_ascii=False), flush=True)
    candidates, provenance = repair_learning(inputs, config=config, progress=progress,
                                             cache_dir=args.output / 'cache', mode='reextract')
    catalog.save(args.output / 'candidates.json', {'sentences': candidates, 'provenance': provenance})
    print(json.dumps({'videoId': video_id, 'sentences': len(candidates),
                      'expressions': sum(len(s['expressions']) for s in candidates), 'status': 'review'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', required=True)
    parser.add_argument('--video', required=True)
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args())
