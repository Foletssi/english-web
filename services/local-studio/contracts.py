import json
import math
import re


class StudioError(Exception):
    def __init__(self, code, message=None, retryable=False):
        super().__init__(f'{code}: {message or code}')
        self.code = code
        self.message = message or code
        self.retryable = retryable


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize_words(value):
    # Keep this identical to the browser and Supabase learning contract.
    # Numbers are context (for example, "11 a.m."), not part of a reusable
    # teaching expression, so both the source and selected phrase omit them.
    return re.sub(r"\s+", " ", re.sub(r"[^a-z' -]", " ", str(value).lower())).strip()


def validate_transcript(rows, duration):
    if not finite(duration) or duration <= 0:
        raise StudioError('INVALID_DURATION', '无法读取视频时长。')
    if not isinstance(rows, list) or not rows:
        raise StudioError('ASR_EMPTY', '没有识别到英文语音，请检查视频音轨。')
    seen = set()
    previous = -1
    for row in rows:
        if not isinstance(row, dict) or not row.get('id'):
            raise StudioError('ASR_SCHEMA', '字幕数据结构不完整。')
        start, end = row.get('startTime'), row.get('endTime')
        if row['id'] in seen or not str(row.get('english', '')).strip():
            raise StudioError('ASR_SENTENCE_INVALID', '字幕句子为空或重复。')
        if not finite(start) or not finite(end) or not 0 <= start < end <= duration + .2:
            raise StudioError('ASR_TIMING_INVALID', '字幕时间轴超出视频范围。')
        if start < previous:
            raise StudioError('ASR_ORDER_INVALID', '字幕时间轴顺序不正确。')
        seen.add(row['id'])
        previous = start
    return rows


def validate_learning(source, payload, minimum_schema_version=3):
    output = payload.get('sentences') if isinstance(payload, dict) else None
    if not isinstance(output, list) or len(output) != len(source):
        raise StudioError('AI_SENTENCE_COUNT', 'AI 返回的字幕数量不一致。', True)
    expected = {row['id'] for row in source}
    if {row.get('id') for row in output if isinstance(row, dict)} != expected:
        raise StudioError('AI_SENTENCE_IDS', 'AI 返回了错误的字幕编号。', True)
    by_id = {row['id']: row for row in output}
    try:
        schema_version = int(payload.get('teachingSchemaVersion', 0))
    except (TypeError, ValueError):
        raise StudioError('AI_TEACHING_SCHEMA', 'AI 教学内容版本无效。', True)
    if schema_version < minimum_schema_version:
        raise StudioError('AI_TEACHING_SCHEMA', 'AI 教学内容版本过旧或缺失。', True)
    merged = []
    for original in source:
        row = by_id[original['id']]
        chinese = str(row.get('chinese', '')).strip()
        grammar = str(row.get('grammar', '')).strip()
        key_words = row.get('keyWords', [])
        expressions = row.get('expressions', [])
        if not chinese or not isinstance(key_words, list) or len(key_words) > 5:
            raise StudioError('AI_SENTENCE_SCHEMA', 'AI 字幕翻译或重点表达格式错误。', True)
        if not isinstance(expressions, list) or len(expressions) != len(key_words):
            raise StudioError('AI_EXPRESSION_COUNT', 'AI 重点表达与释义数量不一致。', True)
        english = ' ' + normalize_words(original['english']) + ' '
        for phrase in key_words:
            normalized = normalize_words(phrase)
            if not normalized or (' ' + normalized + ' ') not in english:
                raise StudioError('AI_PHRASE_NOT_FOUND', 'AI 重点表达不在英文原句中。', True)
        by_surface = {}
        for expression in expressions:
            if not isinstance(expression, dict):
                raise StudioError('AI_EXPRESSION_SCHEMA', 'AI 重点表达释义格式错误。', True)
            surface = normalize_words(expression.get('surface', ''))
            if surface in by_surface or surface not in {normalize_words(x) for x in key_words}:
                raise StudioError('AI_EXPRESSION_SURFACE', 'AI 重点表达释义与重点词不一致。', True)
            core = str(expression.get('coreMeaningZh', '')).strip()
            context = str(expression.get('contextMeaningZh', '')).strip()
            usage = str(expression.get('usageNoteZh', '')).strip()
            if schema_version >= 3:
                expression_type = str(expression.get('expressionType', '')).strip()
                lemma = str(expression.get('lemma', '')).strip()
                reason = str(expression.get('selectionReasonZh', '')).strip()
                if expression_type not in {'word', 'phrasal_verb', 'collocation', 'idiom', 'pattern'}:
                    raise StudioError('AI_EXPRESSION_TYPE', 'AI 重点表达类型无效。', True)
                if not lemma or not reason or not isinstance(expression.get('needsReview'), bool):
                    raise StudioError('AI_TEACHING_FIELDS', 'AI 重点表达缺少教学判断字段。', True)
            if not core or not context or len(core) > 300 or len(context) > 500 or len(usage) > 500:
                raise StudioError('AI_EXPRESSION_MEANING', 'AI 重点表达释义为空或过长。', True)
            by_surface[surface] = {**expression, 'surface': str(expression['surface']).strip(),
                                   'coreMeaningZh': core, 'contextMeaningZh': context,
                                   'usageNoteZh': usage, 'reviewStatus': 'REVIEW', 'source': 'ai'}
        merged.append({**original, 'chinese': chinese, 'grammar': grammar,
                       'keyWords': key_words,
                       'expressions': [by_surface[normalize_words(x)] for x in key_words],
                       'reviewStatus': 'REVIEW',
                       'selectionSource': 'manual' if original.get('selectionLocked') else 'ai',
                       'selectionLocked': bool(original.get('selectionLocked')),
                       'learningContractVersion': 5 if schema_version >= 3 else 4,
                       'learningAnalysis': {'method': 'server-ai', 'requiresReview': True,
                                            'teachingSchemaVersion': schema_version}})
    return merged


def validate_metadata(payload, topic_ids, goal_ids, sentence_ids, tag_ids=None):
    if not isinstance(payload, dict):
        raise StudioError('AI_METADATA_SCHEMA', 'AI 元数据不是 JSON 对象。', True)
    title = str(payload.get('titleZh', '')).strip()
    description = str(payload.get('descriptionZh', '')).strip()
    level = payload.get('level')
    topics = payload.get('topicIds', [])
    goals = payload.get('goalMappings', [])
    tags = payload.get('tags', [])
    if not 4 <= len(title) <= 40 or not 20 <= len(description) <= 180:
        raise StudioError('AI_COPY_INVALID', 'AI 中文标题或简介长度异常。', True)
    if level not in {'A1', 'A2', 'B1', 'B2', 'C1', 'C2'}:
        raise StudioError('AI_LEVEL_INVALID', 'AI 返回了未知难度。', True)
    if not isinstance(topics, list) or not 1 <= len(topics) <= 3 or any(x not in topic_ids for x in topics):
        raise StudioError('AI_TOPIC_INVALID', 'AI 返回了未知分类。', True)
    if not isinstance(goals, list):
        raise StudioError('AI_GOAL_INVALID', 'AI 学习目标格式错误。', True)
    if tag_ids is not None:
        if not isinstance(tags, list) or not 1 <= len(tags) <= 5:
            raise StudioError('AI_TAG_COUNT', 'AI 标签必须有1到5个。', True)
        seen_tags = set()
        for tag in tags:
            evidence = tag.get('sentenceIds', []) if isinstance(tag, dict) else []
            tag_id = tag.get('tagId') if isinstance(tag, dict) else None
            if tag_id not in tag_ids or tag_id in seen_tags or not evidence or any(x not in sentence_ids for x in evidence):
                raise StudioError('AI_TAG_EVIDENCE', 'AI 标签未知、重复或缺少字幕证据。', True)
            reason = str(tag.get('reasonZh', '')).strip()
            if not reason:
                raise StudioError('AI_TAG_REASON', 'AI 标签缺少理由。', True)
            seen_tags.add(tag_id)
            tag['reviewStatus'] = 'REVIEW'
            tag['source'] = 'ai'
    for goal in goals:
        evidence = goal.get('sentenceIds', []) if isinstance(goal, dict) else []
        if goal.get('goalId') not in goal_ids or not evidence or any(x not in sentence_ids for x in evidence):
            raise StudioError('AI_GOAL_EVIDENCE', 'AI 学习目标缺少字幕证据。', True)
        goal['approved'] = False
        goal['status'] = 'REVIEW'
    return {'titleZh': title, 'descriptionZh': description, 'level': level,
            'levelReason': str(payload.get('levelReason', '')).strip(),
            'topicIds': topics, 'tagIds': [x['tagId'] for x in tags],
            'tagAssignments': tags, 'goalMappings': goals}


def strict_json(text):
    try:
        value = json.loads(text)
    except (TypeError, ValueError) as error:
        raise StudioError('AI_INVALID_JSON', 'AI 没有返回有效 JSON。', True) from error
    if not isinstance(value, dict) or not value:
        raise StudioError('AI_EMPTY', 'AI 返回内容为空。', True)
    return value
