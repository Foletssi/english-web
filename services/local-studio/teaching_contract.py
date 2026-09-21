"""Local mirror of the production teaching preflight with actionable errors."""
import re

from contracts import StudioError
from teaching_details import source_tokens, validate_pronunciation_hint
from teaching_voice import AMBIGUOUS_WORDS

PLACEHOLDER = re.compile(r'释义待生成|尚未生成|等待生成|待补充')
TRANSLATION_VERSIONS = {
    ('context-lookup-v2-20260916', 'context-lookup-review-v2-20260916'),
    ('context-lookup-v3-20260919', 'context-lookup-review-v3-20260919'),
    ('context-lookup-v3-20260919', 'context-delta-review-v3-20260919'),
}
COVERAGE_VERSIONS = {
    ('adjacent-coverage-v1-20260916', 'adult-selection-review-v1-20260916'),
    ('adjacent-coverage-v2-20260916', 'adult-selection-review-v2-20260916'),
}


def _utf16_length(value):
    return len(str(value).encode('utf-16-le')) // 2


def _fail(row, field, detail):
    identity = str(row.get('id') or '<missing-id>')[:200] if isinstance(row, dict) else '<invalid-row>'
    raise StudioError('TEACHING_DETAILS_INVALID', f'{identity}: {field} {detail}', False)


def _text(row, value, field, maximum):
    if not isinstance(value, str) or not value.strip() or _utf16_length(value) > maximum or PLACEHOLDER.search(value):
        _fail(row, field, '为空、过长或仍含占位内容。')


def validate_completed_teaching(rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 30000:
        raise StudioError('TEACHING_DETAILS_INVALID', '教学字幕必须是 1 到 30000 条的数组。', False)
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            _fail(row, 'sentence', '不是对象。')
        identity = row.get('id')
        if not isinstance(identity, str) or not 1 <= len(identity.strip()) <= 200 or identity in seen:
            _fail(row, 'id', '为空、过长或重复。')
        seen.add(identity)
        revision = row.get('textRevision', 1)
        if type(revision) is not int or revision < 1:
            _fail(row, 'textRevision', '必须是正整数。')
        if not isinstance(row.get('english'), str):
            _fail(row, 'english', '必须是文本。')
        _text(row, row.get('chinese'), 'chinese', 1000)

        lookup = row.get('wordLookup')
        expected_lookup = source_tokens(row)
        if not isinstance(lookup, dict) or lookup.get('schemaVersion') != 1:
            _fail(row, 'wordLookup.schemaVersion', '必须为 1。')
        if lookup.get('sourceTextRevision') != revision:
            _fail(row, 'wordLookup.sourceTextRevision', '与字幕版本不一致。')
        if lookup.get('sourceEnglish') != row['english']:
            _fail(row, 'wordLookup.sourceEnglish', '与英文原句不一致。')
        tokens = lookup.get('tokens')
        expected_tokens = expected_lookup['tokens']
        if not isinstance(tokens, list) or len(tokens) != len(expected_tokens):
            _fail(row, 'wordLookup.tokens', '没有完整覆盖英文原句。')
        for index, (token, expected) in enumerate(zip(tokens, expected_tokens)):
            prefix = f'wordLookup.tokens[{index}]'
            if not isinstance(token, dict):
                _fail(row, prefix, '不是对象。')
            for field in ('tokenId', 'surface', 'start', 'end'):
                if token.get(field) != expected[field]:
                    _fail(row, f'{prefix}.{field}', '与英文原句的词元身份或 UTF-16 偏移不一致。')
            _text(row, token.get('coreMeaningZh'), f'{prefix}.coreMeaningZh', 160)
            try:
                validate_pronunciation_hint(token.get('pronunciationHint', ''), token['surface'], required=True)
            except StudioError:
                _fail(row, f'{prefix}.pronunciationHint', '不是单一且有效的 IPA。')

        expressions = row.get('expressions', [])
        if not isinstance(expressions, list):
            _fail(row, 'expressions', '必须是数组。')
        for index, expression in enumerate(expressions):
            if not isinstance(expression, dict):
                _fail(row, f'expressions[{index}]', '不是对象。')
            if str(expression.get('reviewStatus', '')).upper() in {'REJECTED', 'DELETED'}:
                continue
            surface = str(expression.get('surface') or '')
            hint = expression.get('pronunciationHint', '')
            required = bool(set(re.findall(r'[a-z]+', surface.lower())) & AMBIGUOUS_WORDS)
            if hint or required:
                try:
                    validate_pronunciation_hint(hint, surface, required=required)
                except StudioError:
                    _fail(row, f'expressions[{index}].pronunciationHint', '不是当前语境下单一且有效的 IPA。')

        translation = row.get('translationAnalysis')
        if not isinstance(translation, dict):
            _fail(row, 'translationAnalysis', '必须是对象。')
        status = translation.get('status')
        concerns = translation.get('sourceConcerns')
        version = (translation.get('promptVersion'), translation.get('reviewVersion'))
        if status not in {'completed', 'source_unresolved'}:
            _fail(row, 'translationAnalysis.status', '必须为 completed 或 source_unresolved。')
        if version not in TRANSLATION_VERSIONS:
            _fail(row, 'translationAnalysis.reviewVersion', f'不支持生成/复核版本组合 {version!r}。')
        if translation.get('sourceTextRevision') != revision:
            _fail(row, 'translationAnalysis.sourceTextRevision', '与字幕版本不一致。')
        if not isinstance(concerns, list) or len(concerns) > 5:
            _fail(row, 'translationAnalysis.sourceConcerns', '必须是最多 5 条的数组。')
        if (status == 'completed') != (len(concerns) == 0):
            _fail(row, 'translationAnalysis.status', '与 sourceConcerns 是否为空不一致。')
        if status == 'source_unresolved' and translation.get('translationOrigin') not in {'retained_source', 'reviewed_candidate'}:
            _fail(row, 'translationAnalysis.translationOrigin', '缺少可靠译文来源。')
        for index, concern in enumerate(concerns):
            _text(row, concern, f'translationAnalysis.sourceConcerns[{index}]', 300)

        coverage = row.get('coverageAnalysis')
        if not isinstance(coverage, dict) or coverage.get('schemaVersion') != 1:
            _fail(row, 'coverageAnalysis.schemaVersion', '必须为 1。')
        coverage_version = (coverage.get('promptVersion'), coverage.get('reviewVersion'))
        if coverage.get('status') != 'completed' or coverage_version not in COVERAGE_VERSIONS:
            _fail(row, 'coverageAnalysis', f'状态或生成/复核版本组合无效：{coverage_version!r}。')
        if coverage.get('sourceTextRevision') != revision:
            _fail(row, 'coverageAnalysis.sourceTextRevision', '与字幕版本不一致。')
        pairs = coverage.get('pairs')
        if not isinstance(pairs, list) or len(pairs) > 2:
            _fail(row, 'coverageAnalysis.pairs', '必须是最多 2 条的数组。')
        if not isinstance(row.get('teachingAnalysis'), dict) or row['teachingAnalysis'].get('reviewVersion') != coverage.get('reviewVersion'):
            _fail(row, 'teachingAnalysis.reviewVersion', '与覆盖复核版本不一致。')
    return rows
