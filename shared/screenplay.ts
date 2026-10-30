import type { ElementType, Project, ScriptElement, SceneMeta } from './types';

export interface ElementInfo {
  label: string;
  short: string;
  /** Ctrl/⌘ + 숫자 단축키 */
  key: string;
}

export const ELEMENT_INFO: Record<ElementType, ElementInfo> = {
  scene: { label: '씬 헤딩', short: 'S#', key: '1' },
  action: { label: '지문', short: '지문', key: '2' },
  character: { label: '인물', short: '인물', key: '3' },
  parenthetical: { label: '괄호', short: '( )', key: '4' },
  dialogue: { label: '대사', short: '대사', key: '5' },
  transition: { label: '전환', short: '전환', key: '6' },
  shot: { label: '샷', short: '샷', key: '7' },
  general: { label: '일반', short: '일반', key: '8' },
};

/** Final Draft 방식: 요소 끝에서 Enter를 누르면 만들어지는 다음 요소 */
export const ENTER_NEXT: Record<ElementType, ElementType> = {
  scene: 'action',
  action: 'action',
  character: 'dialogue',
  parenthetical: 'dialogue',
  dialogue: 'action',
  transition: 'scene',
  shot: 'action',
  general: 'general',
};

/** 빈 요소에서 Enter를 누르면 요소 종류만 바뀐다 */
export const EMPTY_ENTER: Partial<Record<ElementType, ElementType>> = {
  action: 'scene',
  dialogue: 'action',
  character: 'action',
  parenthetical: 'dialogue',
  transition: 'scene',
};

/** Final Draft 방식 Tab 순환 */
export const TAB_NEXT: Record<ElementType, ElementType> = {
  scene: 'action',
  action: 'character',
  character: 'transition',
  transition: 'scene',
  dialogue: 'parenthetical',
  parenthetical: 'dialogue',
  shot: 'action',
  general: 'action',
};

export const SHIFT_TAB_NEXT: Record<ElementType, ElementType> = {
  scene: 'transition',
  action: 'scene',
  character: 'action',
  transition: 'character',
  dialogue: 'character',
  parenthetical: 'dialogue',
  shot: 'scene',
  general: 'action',
};

export function uid(prefix = ''): string {
  const c = globalThis.crypto;
  const raw = c && 'randomUUID' in c ? c.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + raw.slice(0, 12);
}

export function el(type: ElementType, text: string): ScriptElement {
  return { id: uid('e'), type, text };
}

export interface HeadingParts {
  /** INT / EXT / 내부 / 외부 등 */
  place: string;
  location: string;
  time: string;
}

const PLACE_RE = /^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?|내부\/외부|내\/외|내부|외부|실내|실외)[.\s]*/i;
const TIME_SEP_RE = /\s+[-–—]\s+(?!.*\s[-–—]\s)/;

export function parseHeading(text: string): HeadingParts {
  let rest = text.trim();
  let place = '';
  const m = rest.match(PLACE_RE);
  if (m) {
    place = normalizePlace(m[1]);
    rest = rest.slice(m[0].length).trim();
  }
  let time = '';
  const paren = rest.match(/\(([^)]+)\)\s*$/);
  if (paren) {
    time = paren[1].trim();
    rest = rest.slice(0, paren.index).trim();
  } else {
    const sep = rest.search(TIME_SEP_RE);
    if (sep >= 0) {
      time = rest.slice(sep).replace(/^\s+[-–—]\s+/, '').trim();
      rest = rest.slice(0, sep).trim();
    }
  }
  return { place, location: rest, time };
}

function normalizePlace(p: string): string {
  const u = p.toUpperCase().replace(/\.$/, '');
  if (u.startsWith('INT') && u.includes('EXT')) return '내부/외부';
  if (u.startsWith('EXT') && u.includes('INT')) return '내부/외부';
  if (u === 'I/E' || u === '내/외' || u === '내부/외부') return '내부/외부';
  if (u === 'INT' || u === '내부' || u === '실내') return '내부';
  if (u === 'EXT' || u === '외부' || u === '실외') return '외부';
  if (u === 'EST') return '설정';
  return p;
}

export interface SceneInfo {
  id: string;
  /** 원고상 순서 (1부터) */
  number: number;
  /** 표시용 장면 번호. 번호를 고정하면 "41-1"처럼 끼워 넣은 번호가 된다. */
  label: string;
  heading: string;
  parts: HeadingParts;
  /** elements 배열에서 씬 헤딩의 인덱스 */
  start: number;
  /** 다음 씬 헤딩의 인덱스 (배타적) */
  end: number;
  actId: string;
  meta: SceneMeta;
  characters: string[];
}

type SceneSource = Pick<Project, 'elements' | 'acts' | 'sceneMeta'> & Partial<Pick<Project, 'numberingLocked' | 'format'>>;

/**
 * 장면 번호. 고정하지 않으면 1..n.
 * 고정하면 저장된 번호를 쓰고, 번호 없는 새 장면은 앞 장면 뒤에 끼운다 (한국식 41-1, 할리우드식 41A).
 */
export function sceneLabels(project: SceneSource): Map<string, string> {
  const ids = project.elements.filter((e) => e.type === 'scene').map((e) => e.id);
  const out = new Map<string, string>();
  if (!project.numberingLocked) {
    ids.forEach((id, i) => out.set(id, String(i + 1)));
    return out;
  }
  const korean = project.format !== 'hollywood';
  let base = '0';
  let inserted = 0;
  for (const id of ids) {
    const fixed = project.sceneMeta[id]?.label?.trim();
    if (fixed) {
      out.set(id, fixed);
      base = fixed;
      inserted = 0;
      continue;
    }
    inserted++;
    out.set(id, korean ? `${base}-${inserted}` : `${base}${String.fromCharCode(64 + Math.min(inserted, 26))}`);
  }
  return out;
}

/** 지금 보이는 번호를 그대로 고정한다. */
export function lockSceneNumbers(project: SceneSource): Record<string, SceneMeta> {
  const labels = sceneLabels({ ...project, numberingLocked: false });
  const sceneMeta = { ...project.sceneMeta };
  for (const [id, label] of labels) sceneMeta[id] = { ...sceneMeta[id], label };
  return sceneMeta;
}

/** 고정을 풀면 번호를 다시 매긴다. */
export function unlockSceneNumbers(project: SceneSource): Record<string, SceneMeta> {
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const [id, m] of Object.entries(project.sceneMeta)) {
    const { label: _label, ...rest } = m;
    sceneMeta[id] = rest;
  }
  return sceneMeta;
}

/**
 * 출력용 원고: 삭제 장면은 번호와 "삭제"(OMITTED)만 남기고 본문을 뺀다.
 * 씬 헤딩 id는 그대로라 sceneLabels()의 번호를 쓸 수 있다.
 */
export function printableElements(project: SceneSource): ScriptElement[] {
  const out: ScriptElement[] = [];
  let skipping = false;
  for (const e of project.elements) {
    if (e.type === 'scene') {
      skipping = Boolean(project.sceneMeta[e.id]?.omitted);
      out.push(skipping ? { ...e, text: project.format === 'hollywood' ? 'OMITTED' : '삭제' } : e);
    } else if (!skipping) out.push(e);
  }
  return out;
}

/** 원고에서 장면 목록을 만든다. 첫 씬 헤딩 이전의 요소는 장면에 포함되지 않는다. */
export function getScenes(project: SceneSource): SceneInfo[] {
  const { elements, acts, sceneMeta } = project;
  const labels = sceneLabels(project);
  const scenes: SceneInfo[] = [];
  let currentAct = acts[0]?.id ?? '';
  const actIds = new Set(acts.map((a) => a.id));
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e.type !== 'scene') continue;
    if (scenes.length) scenes[scenes.length - 1].end = i;
    const meta = sceneMeta[e.id] ?? {};
    if (meta.act && actIds.has(meta.act)) currentAct = meta.act;
    scenes.push({
      id: e.id,
      number: scenes.length + 1,
      label: labels.get(e.id) ?? String(scenes.length + 1),
      heading: e.text,
      parts: parseHeading(e.text),
      start: i,
      end: elements.length,
      actId: currentAct,
      meta,
      characters: [],
    });
  }
  for (const s of scenes) {
    const names = new Set<string>();
    for (let i = s.start + 1; i < s.end; i++) {
      if (elements[i].type === 'character') {
        const n = characterName(elements[i].text);
        if (n) names.add(n);
      }
    }
    s.characters = [...names];
  }
  return scenes;
}

/** "서윤 (V.O.)" / "JOHN (CONT'D)" → 인물 이름만 */
export function characterName(text: string): string {
  return text.replace(/\(.*?\)/g, '').replace(/\^$/, '').trim();
}

export function sceneIdAt(elements: ScriptElement[], index: number): string | null {
  for (let i = Math.min(index, elements.length - 1); i >= 0; i--) {
    if (elements[i].type === 'scene') return elements[i].id;
  }
  return null;
}

export function sceneElements(elements: ScriptElement[], sceneId: string): ScriptElement[] {
  const start = elements.findIndex((e) => e.id === sceneId);
  if (start < 0) return [];
  let end = start + 1;
  while (end < elements.length && elements[end].type !== 'scene') end++;
  return elements.slice(start, end);
}

/** 장면(씬 헤딩 포함)을 새 요소들로 교체한다. 교체본의 첫 요소가 씬 헤딩이면 기존 id를 유지한다. */
export function replaceScene(elements: ScriptElement[], sceneId: string, replacement: ScriptElement[]): ScriptElement[] {
  const start = elements.findIndex((e) => e.id === sceneId);
  if (start < 0) return elements;
  let end = start + 1;
  while (end < elements.length && elements[end].type !== 'scene') end++;
  const next = replacement.map((e, i) => (i === 0 && e.type === 'scene' ? { ...e, id: sceneId } : e));
  return [...elements.slice(0, start), ...next, ...elements.slice(end)];
}

/**
 * 수정안 요소가 원문과 종류·문장이 같으면 원문의 id를 이어받는다.
 * 그래야 【확정】·태그 같은 요소 표시가 채택 뒤에도 남는다.
 */
export function carryIds(original: ScriptElement[], revised: ScriptElement[]): ScriptElement[] {
  // 요소 종류에는 '|'가 없으므로 키가 겹치지 않는다
  const key = (e: ScriptElement) => `${e.type}|${e.text.trim()}`;
  const pool = new Map<string, string[]>();
  for (const e of original) pool.set(key(e), [...(pool.get(key(e)) ?? []), e.id]);
  return revised.map((e) => {
    const id = pool.get(key(e))?.shift();
    return id ? { ...e, id } : e;
  });
}

/**
 * 장면 순서를 바꾼다. order는 장면 id 목록(전체). 첫 씬 헤딩 이전의 요소는 맨 앞에 남는다.
 */
export function reorderScenes(elements: ScriptElement[], order: string[]): ScriptElement[] {
  const firstScene = elements.findIndex((e) => e.type === 'scene');
  if (firstScene < 0) return elements;
  const head = elements.slice(0, firstScene);
  const blocks = new Map<string, ScriptElement[]>();
  let current: ScriptElement[] | null = null;
  for (let i = firstScene; i < elements.length; i++) {
    const e = elements[i];
    if (e.type === 'scene') {
      current = [e];
      blocks.set(e.id, current);
    } else current!.push(e);
  }
  const result = [...head];
  for (const id of order) {
    const b = blocks.get(id);
    if (b) {
      result.push(...b);
      blocks.delete(id);
    }
  }
  for (const b of blocks.values()) result.push(...b);
  return result;
}

export interface CharacterStat {
  name: string;
  scenes: number;
  dialogues: number;
  words: number;
  firstScene: number;
}

export function characterStats(elements: ScriptElement[]): CharacterStat[] {
  const stats = new Map<string, CharacterStat>();
  let sceneNo = 0;
  let speaker: CharacterStat | null = null;
  const seenInScene = new Set<string>();
  for (const e of elements) {
    if (e.type === 'scene') {
      sceneNo++;
      seenInScene.clear();
      speaker = null;
      continue;
    }
    if (e.type === 'character') {
      const name = characterName(e.text);
      if (!name) continue;
      let s = stats.get(name);
      if (!s) {
        s = { name, scenes: 0, dialogues: 0, words: 0, firstScene: sceneNo };
        stats.set(name, s);
      }
      if (!seenInScene.has(name)) {
        seenInScene.add(name);
        s.scenes++;
      }
      s.dialogues++;
      speaker = s;
      continue;
    }
    if (e.type === 'dialogue' && speaker) {
      speaker.words += e.text.split(/\s+/).filter(Boolean).length;
      continue;
    }
    if (e.type !== 'parenthetical') speaker = null;
  }
  return [...stats.values()].sort((a, b) => b.dialogues - a.dialogues || a.firstScene - b.firstScene);
}

export function knownLocations(elements: ScriptElement[]): string[] {
  const out = new Set<string>();
  for (const e of elements) if (e.type === 'scene') {
    const loc = parseHeading(e.text).location;
    if (loc) out.add(loc);
  }
  return [...out];
}

export const HEADING_PREFIXES: Record<'korean' | 'hollywood', string[]> = {
  korean: ['내부. ', '외부. ', '내부/외부. '],
  hollywood: ['INT. ', 'EXT. ', 'INT./EXT. ', 'EST. '],
};

export const TIMES: Record<'korean' | 'hollywood', string[]> = {
  korean: ['낮', '밤', '아침', '저녁', '새벽', '오후', '연속', '잠시 후'],
  hollywood: ['DAY', 'NIGHT', 'MORNING', 'EVENING', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER', 'MOMENTS LATER'],
};

export const TRANSITIONS = ['CUT TO:', 'FADE OUT.', 'FADE IN:', 'DISSOLVE TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', '컷.', '디졸브.', '페이드 아웃.', '페이드 인.'];

/** 씬 헤딩/인물/전환/샷은 영문일 때 대문자로 표시·출력한다. */
export function displayText(e: Pick<ScriptElement, 'type' | 'text'>): string {
  if (e.type === 'scene' || e.type === 'character' || e.type === 'transition' || e.type === 'shot') return e.text.toUpperCase();
  return e.text;
}

export function normalizeElements(input: unknown): ScriptElement[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: ScriptElement[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<ScriptElement>;
    const type = (ELEMENT_KEYS.has(r.type as string) ? r.type : 'action') as ElementType;
    let id = typeof r.id === 'string' && r.id ? r.id : uid('e');
    if (seen.has(id)) id = uid('e');
    seen.add(id);
    out.push({ id, type, text: typeof r.text === 'string' ? r.text : '' });
  }
  return out;
}

const ELEMENT_KEYS = new Set<string>(Object.keys(ELEMENT_INFO));
