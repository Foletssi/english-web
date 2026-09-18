"""Opt-in, bounded live comparison. Writes only a local report; no job/DB writes."""
import argparse
import copy
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services' / 'local-studio'))
from ai_tools import call_json
from ai_usage import job_usage_config, record_usage, summarize_usage, usage_scope
from checkpoint import atomic_json, canonical_hash
from teaching_details import (DETAIL_PROMPT, REVIEW_PROMPT, source_tokens,
                              expression_voice_sources, validate_details)
from teaching_review import apply_review, REVIEW_PROMPT as DELTA_PROMPT
from teaching_eligibility import (PROMPT as ELIGIBILITY_PROMPT, CONTEXT_TABLE_PROMPT,
                                  eligibility_payload, _validate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Allow at most five real AI requests')
    parser.add_argument('--eligibility-only', action='store_true',
                        help='Compare only full/table eligibility (at most two requests)')
    parser.add_argument('--details-only', action='store_true', help='Only run the three detail requests')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.run:
        parser.error('--run is required for live API calls')
    for target, source in [('ZOSPEAK_AI_API_KEY', 'DEEPSEEK_API_KEY'),
                           ('ZOSPEAK_AI_BASE_URL', 'DEEPSEEK_BASE_URL'),
                           ('ZOSPEAK_AI_MODEL', 'AI_DEEPSEEK_TRANSLATE_MODEL')]:
        if not os.getenv(target) and os.getenv(source):
            os.environ[target] = os.environ[source]
    config = job_usage_config({}, 'm08-efficiency-probe', args.output.parent)
    samples = [
        ("I'm going to see her at the cafe.", 'see her'),
        ("She works there, and we're not dating.", ''),
        ("I'll throw in some laundry before we leave.", 'throw in'),
        ('I read that article yesterday.', 'read'),
        ('They kept the launch under wraps.', 'under wraps'),
        ("The bag's hardware feels flimsy.", 'hardware'),
        ("I won't spill the beans.", 'spill the beans')]
    rows = [{'id': f's{i}', 'english': text, 'chinese': '', 'startTime': i * 3,
             'endTime': i * 3 + 3, 'textRevision': 1,
             'expressions': ([{'expressionId': f'e{i}', 'surface': expression,
                              'coreMeaningZh': '待校对'}] if expression else [])}
            for i, (text, expression) in enumerate(samples)]
    payload = {'sentences': [{'id': row['id'], 'english': row['english'], 'chinese': '',
                'translationLocked': False, 'tokens': source_tokens(row)['tokens'],
                'expressions': expression_voice_sources(row)} for row in rows],
               'contextBefore': [], 'contextAfter': []}
    report = {'kind': 'bounded-live-comparison', 'defaultChanged': False, 'runs': {}}

    def request(stage, prompt, body):
        print(stage + ': started', flush=True)
        with usage_scope(args.output.parent, stage, canonical_hash(body)):
            value, metadata = call_json(config, prompt, body, timeout=180)
        report['runs'][stage] = {'metadata': metadata, 'response': value}
        atomic_json(args.output, report)
        print(stage + ': received', flush=True)
        return value

    try:
        if not args.eligibility_only:
            candidate = request('detail-generate', DETAIL_PROMPT, payload)
            validate_details(rows, candidate)
            # Controlled semantic faults: both reviewers receive exactly this object.
            candidate = copy.deepcopy(candidate)
            by_id = {row['id']: row for row in candidate['sentences']}
            by_id['s0']['chinese'] = '我要去咖啡店和她约会。'
            by_id['s1']['chinese'] = '她在那里工作，我们正在约会。'
            by_id['s2']['chinese'] = '离开前我会额外赠送一些洗好的衣服。'
            by_id['s3']['tokens'][1]['pronunciationHint'] = '/riːd/'
            by_id['s3']['expressions'][0]['pronunciationHint'] = '/riːd/'
            body = {**payload, 'candidate': candidate}
            report['controlledCandidate'] = candidate
            for name, prompt in [('full', REVIEW_PROMPT), ('delta', DELTA_PROMPT)]:
                stage = 'detail-' + name
                response = request(stage, prompt, body)
                try:
                    checked = (validate_details(rows, response) if name == 'full'
                               else apply_review(rows, candidate, response))
                except Exception as error:
                    code = getattr(error, 'code', type(error).__name__)
                    report['runs'][stage]['validationError'] = code
                    with usage_scope(args.output.parent, stage, canonical_hash(body)):
                        record_usage('validation_failed', config, errorCode=code)
                    raise
                report['runs'][stage]['validated'] = checked
                report['runs'][stage]['allTokensPresent'] = all(
                    len(row['wordLookup']['tokens']) == len(source_tokens(source)['tokens'])
                    for source, row in zip(rows, checked))
        expressions = [{'itemId': f'{i}:0', 'sentenceIndex': i, 'expression': row['expressions'][0]}
                       for i, row in enumerate(rows) if row['expressions']]
        for mode, prompt in ([] if args.details_only else [('full', ELIGIBILITY_PROMPT), ('table', CONTEXT_TABLE_PROMPT)]):
            response = request('eligibility-' + mode, prompt, eligibility_payload(rows, expressions, mode))
            report['runs']['eligibility-' + mode]['validated'] = _validate(expressions, response)
    except Exception as error:
        report['errorCode'] = getattr(error, 'code', type(error).__name__)
        print('Probe stopped: ' + report['errorCode'], flush=True)
    finally:
        report['usage'] = summarize_usage(config['usageLogPath'], config['runId'])
        atomic_json(args.output, report)
    return int('errorCode' in report)


if __name__ == '__main__':
    raise SystemExit(main())
