export type Cue = { id: string; startTime: number; endTime: number; english: string };

const timePattern = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/;

function seconds(value: string): number {
  const match = value.trim().match(timePattern);
  if (!match) throw new Error('CAPTION_TIMESTAMP_INVALID');
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseVtt(input: string, videoId: string): Cue[] {
  const blocks = String(input || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, endAndSettings] = lines[timingIndex].split('-->').map((part) => part.trim());
    const endRaw = endAndSettings.split(/\s+/)[0];
    const english = lines.slice(timingIndex + 1).join(' ')
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    if (!english) continue;
    const startTime = seconds(startRaw);
    const endTime = seconds(endRaw);
    if (!(endTime > startTime)) throw new Error('CAPTION_RANGE_INVALID');
    cues.push({ id: `${videoId}-${cues.length + 1}`, startTime, endTime, english });
  }
  if (!cues.length) throw new Error('CAPTION_EMPTY');
  return cues;
}

function normalized(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function validateLearning(cues: Cue[], value: unknown): Record<string, unknown>[] {
  const result = value as { sentences?: unknown[] };
  if (!Array.isArray(result?.sentences) || result.sentences.length !== cues.length) {
    throw new Error('AI_SENTENCE_COUNT_INVALID');
  }
  const byId = new Map(result.sentences.map((row: any) => [String(row?.id || ''), row]));
  return cues.map((cue, order) => {
    const row: any = byId.get(cue.id);
    if (!row || !String(row.chinese || '').trim() || !String(row.grammar || '').trim()) {
      throw new Error('AI_SENTENCE_SCHEMA_INVALID');
    }
    const source = normalized(cue.english);
    const keyWords = Array.isArray(row.keyWords) ? row.keyWords.map(String).map((word: string) => word.trim()).filter(Boolean) : [];
    if (keyWords.some((word: string) => !source.includes(normalized(word)))) throw new Error('AI_KEYWORD_NOT_IN_SOURCE');
    return { ...cue, order, chinese: String(row.chinese).trim(), keyWords, grammar: String(row.grammar).trim(),
      reviewStatus: 'REVIEW', timingSource: 'cloudflare-stream' };
  });
}

const TOPICS = new Set(['daily','travel','food','work','education','technology','nature','culture','health','growth','unclassified']);
const GOALS = new Set(['general','k12','cet4','cet6','postgrad','tem','other_cn','ielts_academic','ielts_general','toefl','pte_duolingo','toeic','cambridge','career','daily','custom']);

export function validateMetadata(value: unknown, sentenceIds: Set<string>) {
  const row: any = value;
  if (!row || !String(row.titleZh || '').trim() || !String(row.descriptionZh || '').trim() ||
      !['A1','A2','B1','B2','C1','C2'].includes(String(row.level || ''))) throw new Error('AI_METADATA_SCHEMA_INVALID');
  const topicIds = Array.isArray(row.topicIds) ? [...new Set(row.topicIds.map(String).filter((id: string) => TOPICS.has(id)))] : [];
  const goalMappings = Array.isArray(row.goalMappings) ? row.goalMappings.filter((item: any) =>
    GOALS.has(String(item?.goalId || '')) && Array.isArray(item.sentenceIds) &&
    item.sentenceIds.length && item.sentenceIds.every((id: unknown) => sentenceIds.has(String(id))) && String(item.reason || '').trim()
  ).map((item: any) => ({ goalId: String(item.goalId), sentenceIds: item.sentenceIds.map(String), reason: String(item.reason).trim() })) : [];
  return { titleZh: String(row.titleZh).trim(), descriptionZh: String(row.descriptionZh).trim().slice(0, 500),
    level: String(row.level), levelReason: String(row.levelReason || '').trim(), topicIds: topicIds.length ? topicIds : ['unclassified'], goalMappings };
}

export function stageProgress(stage: string): number {
  return ({ STREAM_SUBMIT: 8, STREAM_ENCODING: 25, CAPTIONING: 55, ENRICH: 72, METADATA: 92, REVIEW: 100 } as Record<string, number>)[stage] || 0;
}
