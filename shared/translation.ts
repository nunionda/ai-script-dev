import type { Project, ScriptElement, TranslationLink } from './types';
import { getScenes, replaceScene, sceneElements } from './screenplay';

/**
 * 영문 병행본: 한국어 정본의 장면을 하나씩 번역해 병행본 원고에 놓는다.
 * 연결은 정본 장면 id → 병행본 장면 id. 정본이 번역 뒤에 바뀌면 지문(hash)이 달라져 "갱신 필요"가 된다.
 */

/** 장면 내용 지문 (FNV-1a). 요소 종류와 문장만 본다. */
export function sceneHash(elements: Pick<ScriptElement, 'type' | 'text'>[]): string {
  let h = 0x811c9dc5;
  const s = elements.map((e) => `${e.type}\u0001${e.text.trim()}`).join('\u0002');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 한국식 추가 장면 번호 41-1 → 할리우드식 41A */
export function hollywoodLabel(label: string): string {
  const m = label.match(/^(\d+)-(\d+)$/);
  if (!m) return label;
  const n = Number(m[2]);
  return n >= 1 && n <= 26 ? `${m[1]}${String.fromCharCode(64 + n)}` : label;
}

type Source = Pick<Project, 'elements' | 'acts' | 'sceneMeta' | 'numberingLocked' | 'format'>;

/**
 * 번역한 장면을 병행본 원고에 놓는다. 이미 번역한 장면이면 그 자리를 바꾸고,
 * 아니면 정본 순서상 앞에 있는 번역된 장면 가운데 가장 가까운 것 뒤에 넣는다.
 */
export function placeTranslatedScene(
  target: ScriptElement[],
  link: TranslationLink,
  source: Source,
  sourceSceneId: string,
  translated: ScriptElement[],
): { elements: ScriptElement[]; targetSceneId: string } {
  const existing = link.scenes[sourceSceneId]?.targetSceneId;
  if (existing && target.some((e) => e.id === existing)) {
    return { elements: replaceScene(target, existing, translated), targetSceneId: existing };
  }
  // 빈 원고의 빈 헤딩 하나는 자리표시로 보고 지운다
  const base = target.length === 1 && target[0].type === 'scene' && !target[0].text.trim() ? [] : target;
  const order = getScenes(source).map((s) => s.id);
  const at = order.indexOf(sourceSceneId);
  let insertAt = 0;
  for (let i = at - 1; i >= 0; i--) {
    const prev = link.scenes[order[i]]?.targetSceneId;
    const idx = prev ? base.findIndex((e) => e.id === prev) : -1;
    if (idx >= 0) {
      insertAt = idx + sceneElements(base, prev!).length;
      break;
    }
  }
  return { elements: [...base.slice(0, insertAt), ...translated, ...base.slice(insertAt)], targetSceneId: translated[0].id };
}

export type SceneSyncState = 'untranslated' | 'current' | 'stale' | 'missing' | 'omitted';

export interface SceneSync {
  sourceSceneId: string;
  label: string;
  heading: string;
  state: SceneSyncState;
  targetSceneId?: string;
}

/** 정본 장면마다 번역 상태: 미번역 / 최신 / 갱신 필요 / 병행본에서 지워짐 / 정본에서 삭제 */
export function syncStatus(source: Source, target: Pick<Project, 'elements'>, link: TranslationLink): SceneSync[] {
  const targetIds = new Set(target.elements.filter((e) => e.type === 'scene').map((e) => e.id));
  return getScenes(source).map((s) => {
    const t = link.scenes[s.id];
    const base = { sourceSceneId: s.id, label: s.label, heading: s.heading, targetSceneId: t?.targetSceneId };
    if (s.meta.omitted) return { ...base, state: 'omitted' };
    if (!t) return { ...base, state: 'untranslated' };
    if (!targetIds.has(t.targetSceneId)) return { ...base, state: 'missing' };
    return { ...base, state: t.sourceHash === sceneHash(sceneElements(source.elements, s.id)) ? 'current' : 'stale' };
  });
}
