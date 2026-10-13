import { describe, expect, it } from 'vitest';
import { characterStats, el, getScenes, parseHeading, reorderScenes, replaceScene, sceneElements } from './screenplay';
import { paginate, wrapText, textWidth, LINES_PER_PAGE } from './pagination';
import { fromFountain, toFountain } from './fountain';
import { fromFdx, toFdx } from './fdx';
import { diffElements, summarizeDiff } from './diff';
import { sampleProject } from './sample';
import type { ScriptElement } from './types';

const strip = (els: ScriptElement[]) => els.map(({ type, text }) => ({ type, text }));

describe('parseHeading', () => {
  it('parses Hollywood headings', () => {
    expect(parseHeading('INT. PROJECTION BOOTH - NIGHT')).toEqual({ place: '내부', location: 'PROJECTION BOOTH', time: 'NIGHT' });
    expect(parseHeading('ext. alley — dusk')).toEqual({ place: '외부', location: 'alley', time: 'dusk' });
    expect(parseHeading('INT./EXT. CAR - MOVING - DAY').time).toBe('DAY');
    expect(parseHeading('INT./EXT. CAR - MOVING - DAY').location).toBe('CAR - MOVING');
  });
  it('parses Korean headings', () => {
    expect(parseHeading('내부. 영사실 - 밤')).toEqual({ place: '내부', location: '영사실', time: '밤' });
    expect(parseHeading('영사실 (밤)')).toEqual({ place: '', location: '영사실', time: '밤' });
  });
});

describe('scenes', () => {
  const p = sampleProject();
  it('derives scenes with acts that carry forward', () => {
    const scenes = getScenes(p);
    expect(scenes).toHaveLength(5);
    expect(scenes.map((s) => s.actId)).toEqual([p.acts[0].id, p.acts[0].id, p.acts[1].id, p.acts[1].id, p.acts[2].id]);
    expect(scenes[2].characters.sort()).toEqual(['동하', '서윤'].sort());
  });
  it('reorders scene blocks without losing elements', () => {
    const scenes = getScenes(p);
    const order = [scenes[2].id, scenes[0].id, scenes[1].id, scenes[3].id, scenes[4].id];
    const next = reorderScenes(p.elements, order);
    expect(next).toHaveLength(p.elements.length);
    expect(getScenes({ ...p, elements: next }).map((s) => s.id)).toEqual(order);
  });
  it('replaces a scene keeping its heading id', () => {
    const scenes = getScenes(p);
    const target = scenes[2].id;
    const replacement = [el('scene', '내부. 영사실 - 밤'), el('action', '새 지문')];
    const next = replaceScene(p.elements, target, replacement);
    expect(sceneElements(next, target).map((e) => e.text)).toEqual(['내부. 영사실 - 밤', '새 지문']);
    expect(getScenes({ ...p, elements: next })).toHaveLength(5);
  });
  it('counts character dialogue', () => {
    const stats = characterStats(p.elements);
    const seo = stats.find((s) => s.name === '서윤')!;
    expect(seo.dialogues).toBe(3);
    expect(seo.scenes).toBe(3);
  });
});

describe('pagination', () => {
  it('measures Hangul as double width', () => {
    expect(textWidth('가나')).toBe(4);
    expect(wrapText('가나다라 마바사', 8)).toEqual(['가나다라', '마바사']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('breaks long scripts into pages and never orphans a heading', () => {
    const els: ScriptElement[] = [];
    for (let i = 0; i < 40; i++) {
      els.push(el('scene', `INT. ROOM ${i} - DAY`), el('action', 'Something happens here that takes a little room on the page.'));
      els.push(el('character', 'ANNA'), el('dialogue', 'A line of dialogue that wraps over more than one line in the dialogue column.'));
    }
    const p = paginate(els);
    expect(p.pageCount).toBeGreaterThan(5);
    for (const [id] of p.breaks) {
      const idx = els.findIndex((e) => e.id === id);
      // 페이지 마지막 요소가 씬 헤딩이면 안 된다
      expect(els[idx - 1].type).not.toBe('scene');
      // 대사는 인물과 떨어지지 않는다
      expect(els[idx].type).not.toBe('dialogue');
    }
    const total = [...p.sceneEighths.values()].reduce((a, b) => a + b, 0) / 8;
    expect(Math.abs(total - p.pageCount)).toBeLessThan(p.pageCount * 0.3 + 1);
    expect(LINES_PER_PAGE).toBe(55);
  });
});

describe('fountain', () => {
  it('round-trips a Korean script', () => {
    const p = sampleProject();
    const text = toFountain(p);
    expect(text).toContain('Title: 마지막 상영');
    expect(text).toContain('.내부. 영사실 - 밤'.slice(1));
    const back = fromFountain(text);
    expect(back.title).toBe('마지막 상영');
    expect(strip(back.elements)).toEqual(strip(p.elements));
    expect(back.acts.map((a) => a.title)).toEqual(p.acts.map((a) => a.title));
    const scenes = getScenes(back);
    expect(scenes[2].meta.synopsis).toContain('필름');
    expect(scenes.map((s) => back.acts.findIndex((a) => a.id === s.actId))).toEqual([0, 0, 1, 1, 2]);
  });
  it('parses standard fountain', () => {
    const src = `Title: Brick & Steel\nAuthor: Stu Maschwitz\n\nEXT. BRICK'S PATIO - DAY\n\nA gorgeous day.\n\nSTEEL\n(beer raised)\nTo retirement.\n\nBRICK\nTo retirement.\n\nCUT TO:\n\n.SNIPER SCOPE POV\n\n@McCLANE\nYippee ki-yay.\n`;
    const r = fromFountain(src);
    expect(r.title).toBe('Brick & Steel');
    expect(r.author).toBe('Stu Maschwitz');
    expect(strip(r.elements)).toEqual([
      { type: 'scene', text: "EXT. BRICK'S PATIO - DAY" },
      { type: 'action', text: 'A gorgeous day.' },
      { type: 'character', text: 'STEEL' },
      { type: 'parenthetical', text: '(beer raised)' },
      { type: 'dialogue', text: 'To retirement.' },
      { type: 'character', text: 'BRICK' },
      { type: 'dialogue', text: 'To retirement.' },
      { type: 'transition', text: 'CUT TO:' },
      { type: 'scene', text: 'SNIPER SCOPE POV' },
      { type: 'character', text: 'McCLANE' },
      { type: 'dialogue', text: 'Yippee ki-yay.' },
    ]);
  });
});

describe('fdx', () => {
  it('round-trips through Final Draft XML', () => {
    const p = sampleProject();
    const xml = toFdx(p);
    expect(xml).toContain('<Paragraph Type="Scene Heading">');
    const back = fromFdx(xml);
    expect(back.title).toBe('마지막 상영');
    // FDX에서는 여러 줄 지문이 줄마다 문단으로 나뉜다
    const flatten = (els: ScriptElement[]) => els.flatMap((e) => (e.type === 'dialogue' ? [e] : e.text.split('\n').map((t) => ({ ...e, text: t }))));
    expect(strip(back.elements)).toEqual(strip(flatten(p.elements)));
    expect(Object.values(back.sceneMeta).some((m) => m.synopsis?.includes('필름'))).toBe(true);
  });
  it('escapes special characters', () => {
    const xml = toFdx({ title: 'A & B', author: '', contact: '', sceneMeta: {}, elements: [el('action', '<tag> & "q"')] });
    expect(fromFdx(xml).elements[0].text).toBe('<tag> & "q"');
  });
});

describe('diff', () => {
  it('pairs replaced lines as changes', () => {
    const a = [el('action', 'one'), el('character', 'A'), el('dialogue', 'old line'), el('action', 'end')];
    const b = [el('action', 'one'), el('character', 'A'), el('dialogue', 'new line'), el('action', 'added'), el('action', 'end')];
    const ops = diffElements(a, b);
    expect(ops.map((o) => o.kind)).toEqual(['same', 'same', 'change', 'add', 'same']);
    expect(summarizeDiff(ops)).toEqual({ added: 1, removed: 0, changed: 1 });
  });
});

import { suggest } from './suggest';

describe('smart type suggestions', () => {
  const ctx = { characters: ['서윤', '동하', 'STEEL'], locations: ['영사실', '로비', 'PATIO'], format: 'korean' as const };
  it('completes character names', () => {
    expect(suggest('character', '서', ctx)).toEqual(['서윤']);
    expect(suggest('character', 'st', ctx)).toEqual(['STEEL']);
    expect(suggest('character', '서윤', ctx)).toEqual([]);
  });
  it('walks a scene heading prefix → location → time', () => {
    expect(suggest('scene', '', ctx)[0]).toBe('내부. ');
    expect(suggest('scene', '외', ctx)).toEqual(['외부. ']);
    expect(suggest('scene', '내부. 영', ctx)).toEqual(['내부. 영사실']);
    expect(suggest('scene', '내부. 영사실 - ', ctx)[0]).toBe('내부. 영사실 - 낮');
    expect(suggest('scene', '내부. 영사실 - 밤', ctx)).toEqual([]);
    expect(suggest('scene', 'INT. PATIO - N', { ...ctx, format: 'hollywood' })).toEqual(['INT. PATIO - NIGHT']);
  });
  it('offers transitions', () => {
    expect(suggest('transition', 'cut', ctx)).toEqual(['CUT TO:']);
  });
});

describe('diff on long scripts', () => {
  it('handles a small edit in a long script quickly', () => {
    const a = Array.from({ length: 4000 }, (_, i) => el('action', `line ${i}`));
    const b = a.map((x, i) => (i === 2000 ? { ...x, text: 'edited' } : x));
    const t = performance.now();
    const ops = diffElements(a, b);
    expect(performance.now() - t).toBeLessThan(200);
    expect(summarizeDiff(ops)).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(ops).toHaveLength(4000);
  });
});
