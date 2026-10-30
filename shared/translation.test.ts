import { describe, expect, it } from 'vitest';
import { el, getScenes, sceneElements } from './screenplay';
import { hollywoodLabel, placeTranslatedScene, sceneHash, syncStatus } from './translation';
import type { TranslationLink } from './types';

const s1 = el('scene', '내부. 방 - 밤');
const s2 = el('scene', '외부. 골목 - 새벽');
const s3 = el('scene', '내부. 촬영장 - 낮');
const source = {
  elements: [s1, el('action', '반지를 쥔다.'), s2, el('dialogue', '가자.'), s3, el('action', '불이 꺼진다.')],
  acts: [],
  sceneMeta: {},
  numberingLocked: false,
  format: 'korean' as const,
};
const link = (scenes: TranslationLink['scenes'] = {}): TranslationLink => ({ sourceProjectId: 'src', language: 'en', scenes, names: {} });
const tr = (heading: string) => [el('scene', heading), el('action', `${heading} body`)];

describe('parallel version', () => {
  it('fingerprints scene content and converts added-scene numbers', () => {
    expect(sceneHash([s1])).toBe(sceneHash([{ type: 'scene', text: ' 내부. 방 - 밤 ' }]));
    expect(sceneHash([s1])).not.toBe(sceneHash([s2]));
    expect(hollywoodLabel('41-1')).toBe('41A');
    expect(hollywoodLabel('41-2')).toBe('41B');
    expect(hollywoodLabel('12')).toBe('12');
  });

  it('places translated scenes in source order and replaces on retranslation', () => {
    let l = link();
    // 빈 원고의 자리표시 헤딩은 사라진다
    let r = placeTranslatedScene([el('scene', '')], l, source, s3.id, tr('INT. SET - DAY'));
    l = link({ [s3.id]: { targetSceneId: r.targetSceneId, sourceHash: '', targetHash: '', translatedAt: '', losses: [] } });
    r = placeTranslatedScene(r.elements, l, source, s1.id, tr('INT. ROOM - NIGHT'));
    l.scenes[s1.id] = { targetSceneId: r.targetSceneId, sourceHash: '', targetHash: '', translatedAt: '', losses: [] };
    r = placeTranslatedScene(r.elements, l, source, s2.id, tr('EXT. ALLEY - DAWN'));
    l.scenes[s2.id] = { targetSceneId: r.targetSceneId, sourceHash: '', targetHash: '', translatedAt: '', losses: [] };
    const headings = (els: typeof r.elements) => els.filter((e) => e.type === 'scene').map((e) => e.text);
    expect(headings(r.elements)).toEqual(['INT. ROOM - NIGHT', 'EXT. ALLEY - DAWN', 'INT. SET - DAY']);

    const again = placeTranslatedScene(r.elements, l, source, s2.id, tr('EXT. BACK ALLEY - DAWN'));
    expect(again.targetSceneId).toBe(l.scenes[s2.id].targetSceneId);
    expect(headings(again.elements)).toEqual(['INT. ROOM - NIGHT', 'EXT. BACK ALLEY - DAWN', 'INT. SET - DAY']);
  });

  it('reports untranslated, current, stale, missing, and omitted scenes', () => {
    const t1 = el('scene', 'INT. ROOM - NIGHT');
    const hash = (id: string) => sceneHash(sceneElements(source.elements, id));
    const l = link({
      [s1.id]: { targetSceneId: t1.id, sourceHash: hash(s1.id), targetHash: '', translatedAt: '', losses: [] },
      [s2.id]: { targetSceneId: 'gone', sourceHash: hash(s2.id), targetHash: '', translatedAt: '', losses: [] },
    });
    expect(syncStatus(source, { elements: [t1] }, l).map((r) => r.state)).toEqual(['current', 'missing', 'untranslated']);
    const edited = { ...source, elements: source.elements.map((e) => (e.text === '반지를 쥔다.' ? { ...e, text: '반지를 놓는다.' } : e)) };
    expect(syncStatus(edited, { elements: [t1] }, l)[0].state).toBe('stale');
    const omitted = { ...source, sceneMeta: { [s3.id]: { omitted: true } } };
    expect(syncStatus(omitted, { elements: [t1] }, l)[2].state).toBe('omitted');
    expect(getScenes(source)).toHaveLength(3);
  });
});

describe('model output repair', () => {
  it('splits a whole scene written into one element', async () => {
    const { expandRuns } = await import('./fountain');
    const out = expandRuns([
      { type: 'scene', text: 'EXT. HAN RIVER - DAY\n\nBikes pass.\n\nBOGEOM\n(wringing his hair)\nWhere have you been?' },
    ]);
    expect(out.map((e) => e.type)).toEqual(['scene', 'action', 'character', 'parenthetical', 'dialogue']);
    expect(expandRuns([{ type: 'dialogue', text: '한 줄' }])).toEqual([{ type: 'dialogue', text: '한 줄' }]);
  });
});
