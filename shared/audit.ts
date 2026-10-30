import type { AuditFinding, ElementTag, MotifStage, Project, ScriptElement, TagCategory } from './types';
import { characterName, getScenes, replaceScene, sceneElements } from './screenplay';

/**
 * 셀 수 있는 규칙은 AI에 맡기지 않고 여기서 판정한다.
 * 코드(C2, C4 …)는 수정안 자기 검수 체크리스트(server/ai.ts CHECKLIST)와 같다.
 */

type AuditSource = Pick<
  Project,
  'elements' | 'acts' | 'sceneMeta' | 'format' | 'numberingLocked' | 'elementMarks' | 'tagCategories' | 'bannedWords' | 'auditOptions'
>;

export const STAGE_LABEL: Record<MotifStage, string> = { setup: '셋업', variation: '변주', payoff: '회수' };

export interface TagHit {
  sceneId: string | null;
  elementId: string;
  text: string;
  tag: ElementTag;
}

/** 분류별로 원고 순서대로 태그가 붙은 요소를 모은다. 원고에서 지워진 요소의 표시는 무시한다. */
export function tagHits(p: Pick<Project, 'elements' | 'elementMarks'>): Map<string, TagHit[]> {
  const out = new Map<string, TagHit[]>();
  let sceneId: string | null = null;
  for (const e of p.elements) {
    if (e.type === 'scene') sceneId = e.id;
    for (const tag of p.elementMarks[e.id]?.tags ?? []) {
      out.set(tag.cat, [...(out.get(tag.cat) ?? []), { sceneId, elementId: e.id, text: e.text, tag }]);
    }
  }
  return out;
}

export interface CounterStatus {
  category: TagCategory;
  count: number;
  /** 'over'는 FAIL, 'under'는 아직 다 쓰지 않음 */
  state: 'ok' | 'over' | 'under';
}

export function counterStatus(p: Pick<Project, 'elements' | 'elementMarks' | 'tagCategories'>): CounterStatus[] {
  const hits = tagHits(p);
  return p.tagCategories
    .filter((c) => c.exact !== undefined || c.max !== undefined)
    .map((category) => {
      const count = hits.get(category.id)?.length ?? 0;
      const limit = category.exact ?? category.max!;
      const state = count > limit ? 'over' : category.exact !== undefined && count < category.exact ? 'under' : 'ok';
      return { category, count, state };
    });
}

export interface LedgerRow {
  category: TagCategory;
  hits: TagHit[];
}

/** 모티프 장부: 모티프별 셋업 / 변주 / 회수 위치 */
export function motifLedger(p: Pick<Project, 'elements' | 'elementMarks' | 'tagCategories'>): LedgerRow[] {
  const hits = tagHits(p);
  return p.tagCategories.filter((c) => c.kind === 'motif').map((category) => ({ category, hits: hits.get(category.id) ?? [] }));
}

const VOICE_OVER = /\(\s*(V\.?\s?O\.?|NAR\.?|내레이션|보이스\s?오버)\s*\)/i;

export function isVoiceOver(e: Pick<ScriptElement, 'type' | 'text'>): boolean {
  return e.type === 'character' && VOICE_OVER.test(e.text);
}

/** 대사·괄호 지시에 들어간 금지어. 〈극중극〉 요소는 예외. */
export function bannedHits(elements: ScriptElement[], p: Pick<Project, 'bannedWords' | 'elementMarks'>): { element: ScriptElement; word: string }[] {
  const words = p.bannedWords.map((w) => w.trim()).filter(Boolean);
  if (!words.length) return [];
  const out: { element: ScriptElement; word: string }[] = [];
  for (const e of elements) {
    if ((e.type !== 'dialogue' && e.type !== 'parenthetical') || p.elementMarks[e.id]?.play) continue;
    const word = words.find((w) => e.text.includes(w));
    if (word) out.push({ element: e, word });
  }
  return out;
}

/** 【확정】 요소 중 수정안에 같은 종류·같은 문장으로 남지 않은 것 */
export function lockedChanged(original: ScriptElement[], revised: ScriptElement[], marks: Project['elementMarks']): ScriptElement[] {
  const remaining = revised.map((e) => `${e.type}|${e.text.trim()}`);
  return original.filter((e) => {
    if (!marks[e.id]?.locked) return false;
    const i = remaining.indexOf(`${e.type}|${e.text.trim()}`);
    if (i < 0) return true;
    remaining.splice(i, 1);
    return false;
  });
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 작품 전체 점검 */
export function auditProject(p: AuditSource): AuditFinding[] {
  const out: AuditFinding[] = [];
  const scenes = getScenes(p);
  const live = scenes.filter((s) => !s.meta.omitted);
  const sceneNo = new Map(scenes.map((s) => [s.id, s.label]));
  const at = (id: string | null) => (id ? `S#${sceneNo.get(id)}` : '첫 장면 앞');

  if (p.auditOptions.requireSceneCard) {
    live.forEach((s, i) => {
      const m = s.meta;
      if (i > 0 && !m.link) out.push({ code: 'C6', level: 'warn', sceneId: s.id, message: `S#${s.label}: 직전 장면과의 연결어(그래서/그러나)가 없습니다.` });
      if (m.link === 'andthen') out.push({ code: 'C6', level: 'fail', sceneId: s.id, message: `S#${s.label}: 직전 장면과 '그리고 나서'로 이어집니다.` });
      if (!m.valueStart?.trim() || !m.valueEnd?.trim()) out.push({ code: 'C4', level: 'warn', sceneId: s.id, message: `S#${s.label}: 시작 가치와 끝 가치가 비어 있습니다.` });
      else if (m.valueStart.trim() === m.valueEnd.trim()) out.push({ code: 'C4', level: 'fail', sceneId: s.id, message: `S#${s.label}: 가치가 바뀌지 않습니다 (${m.valueStart.trim()}).` });
      if (!m.turnBy && m.valueStart?.trim() && m.valueEnd?.trim()) out.push({ code: 'C4', level: 'warn', sceneId: s.id, message: `S#${s.label}: 전환 수단(행동/폭로)이 정해지지 않았습니다.` });
    });
  }

  for (const c of counterStatus(p)) {
    const limit = c.category.exact ?? c.category.max;
    if (c.state === 'over') out.push({ code: 'C10', level: 'fail', message: `"${c.category.name}" ${c.count}회 — 한도 ${limit}회를 넘었습니다.` });
    if (c.state === 'under') out.push({ code: 'C10', level: 'warn', message: `"${c.category.name}" ${c.count}회 — 정확히 ${limit}회여야 합니다.` });
  }

  const known = new Set(p.tagCategories.map((c) => c.id));
  for (const [cat, hits] of tagHits(p)) {
    if (!known.has(cat)) {
      for (const h of hits) out.push({ code: 'C11', level: 'warn', sceneId: h.sceneId ?? undefined, elementId: h.elementId, message: `${at(h.sceneId)}: 등록되지 않은 태그 분류가 붙어 있습니다.` });
    }
  }
  for (const row of motifLedger(p)) {
    const firstSetup = row.hits.findIndex((h) => h.tag.stage === 'setup');
    row.hits.forEach((h, i) => {
      if (h.tag.stage === 'payoff' && (firstSetup < 0 || firstSetup > i)) {
        out.push({ code: 'C11', level: 'fail', sceneId: h.sceneId ?? undefined, elementId: h.elementId, message: `${at(h.sceneId)}: "${row.category.name}" 회수 앞에 셋업이 없습니다.` });
      }
    });
    if (firstSetup >= 0 && !row.hits.slice(firstSetup).some((h) => h.tag.stage === 'payoff')) {
      out.push({ code: 'C11', level: 'warn', message: `"${row.category.name}" 셋업(${at(row.hits[firstSetup].sceneId)})이 아직 회수되지 않았습니다.` });
    }
  }

  let sceneId: string | null = null;
  for (const e of p.elements) {
    if (e.type === 'scene') sceneId = e.id;
    if (p.auditOptions.banVoiceOver && isVoiceOver(e)) {
      out.push({ code: 'C8', level: 'fail', sceneId: sceneId ?? undefined, elementId: e.id, message: `${at(sceneId)}: ${characterName(e.text)}의 V.O.·내레이션이 있습니다.` });
    }
  }
  for (const { element, word } of bannedHits(p.elements, p)) {
    const sid = sceneOf(p.elements, element.id);
    out.push({ code: 'C9', level: 'fail', sceneId: sid ?? undefined, elementId: element.id, message: `${at(sid)}: 주제어 "${word}"를 말합니다 — "${clip(element.text)}"` });
  }
  return out;
}

function sceneOf(elements: ScriptElement[], elementId: string): string | null {
  let sceneId: string | null = null;
  for (const e of elements) {
    if (e.type === 'scene') sceneId = e.id;
    if (e.id === elementId) return sceneId;
  }
  return null;
}

/** 수정안 하나를 원고에 넣었다고 보고 점검한다. 장면 안의 위반과 작품 전체 횟수 한도만 본다. */
export function auditRevision(p: AuditSource, sceneId: string, revised: ScriptElement[]): AuditFinding[] {
  const original = sceneElements(p.elements, sceneId);
  const out: AuditFinding[] = [];
  for (const e of lockedChanged(original, revised, p.elementMarks)) {
    out.push({ code: 'C2', level: 'fail', elementId: e.id, message: `【확정】 표현이 바뀌거나 빠졌습니다 — "${clip(e.text)}"` });
  }
  if (p.auditOptions.banVoiceOver) {
    for (const e of revised) if (isVoiceOver(e)) out.push({ code: 'C8', level: 'fail', message: `V.O.·내레이션을 썼습니다 — "${e.text}"` });
  }
  for (const { element, word } of bannedHits(revised, p)) {
    out.push({ code: 'C9', level: 'fail', message: `주제어 "${word}"를 말합니다 — "${clip(element.text)}"` });
  }
  const merged = { ...p, elements: replaceScene(p.elements, sceneId, revised) };
  for (const c of counterStatus(merged)) {
    if (c.state === 'over') out.push({ code: 'C10', level: 'fail', message: `"${c.category.name}" ${c.count}회 — 한도 ${c.category.exact ?? c.category.max}회를 넘습니다.` });
  }
  return out;
}
