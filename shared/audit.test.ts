import { describe, expect, it } from 'vitest';
import { carryIds, el, getScenes, lockSceneNumbers, printableElements, sceneElements } from './screenplay';
import { auditProject, auditRevision, counterStatus, lockedChanged, motifLedger } from './audit';
import { bibleDefaults } from './sample';
import { documentsBlock, bibleBlock, formatElements } from '../server/prompts';
import type { Project, ScriptElement } from './types';

type P = Omit<Project, 'id' | 'rev' | 'createdAt' | 'updatedAt'>;

function project(elements: ScriptElement[], extra: Partial<P> = {}): P {
  return {
    title: '갈피',
    logline: '',
    genre: '',
    author: '',
    contact: '',
    format: 'korean',
    status: '',
    elements,
    acts: [],
    sceneMeta: {},
    characters: {},
    ...bibleDefaults(),
    openQuestions: [],
    ...extra,
  };
}

const s1 = el('scene', '내부. 방 - 밤');
const a1 = el('action', '반지를 손에 쥔다.');
const s2 = el('scene', '외부. 골목 - 새벽');
const c2 = el('character', '세영');
const d2 = el('dialogue', '나는 자유야.');
const s3 = el('scene', '내부. 촬영장 - 낮');
const a3 = el('action', '반지가 바닥에 떨어진다.');
const base = [s1, a1, s2, c2, d2, s3, a3];

describe('scene numbering', () => {
  it('numbers 1..n when not locked', () => {
    expect(getScenes(project(base)).map((s) => s.label)).toEqual(['1', '2', '3']);
  });

  it('keeps locked numbers and inserts 41-1 style numbers for new scenes', () => {
    const p = project(base);
    const locked = project(base, { numberingLocked: true, sceneMeta: lockSceneNumbers(p) });
    const added = el('scene', '내부. 계단 - 밤');
    const elements = [s1, a1, added, s2, c2, d2, s3, a3];
    expect(getScenes({ ...locked, elements }).map((s) => s.label)).toEqual(['1', '1-1', '2', '3']);
    expect(getScenes({ ...locked, elements, format: 'hollywood' }).map((s) => s.label)).toEqual(['1', '1A', '2', '3']);
  });

  it('keeps the number of an omitted scene and drops its body when printed', () => {
    const p = project(base, { sceneMeta: { [s2.id]: { omitted: true } } });
    expect(getScenes(p).map((s) => s.label)).toEqual(['1', '2', '3']);
    const printed = printableElements(p);
    expect(printed.map((e) => e.text)).toEqual(['내부. 방 - 밤', '반지를 손에 쥔다.', '삭제', '내부. 촬영장 - 낮', '반지가 바닥에 떨어진다.']);
  });
});

describe('audit', () => {
  it('flags scene-card links and unchanged values when required', () => {
    const p = project(base, {
      auditOptions: { banVoiceOver: false, requireSceneCard: true },
      sceneMeta: {
        [s1.id]: { valueStart: '고립 −', valueEnd: '연결 +', turnBy: 'action' },
        [s2.id]: { link: 'andthen', valueStart: '희망 +', valueEnd: '희망 +' },
        [s3.id]: { valueStart: '불신 −', valueEnd: '신뢰 +', turnBy: 'revelation' },
      },
    });
    const f = auditProject(p);
    expect(f.filter((x) => x.level === 'fail').map((x) => x.code).sort()).toEqual(['C4', 'C6']);
    expect(f.some((x) => x.code === 'C6' && x.level === 'warn' && x.sceneId === s3.id)).toBe(true);
  });

  it('counts tags against exact and max limits', () => {
    const p = project(base, {
      tagCategories: [
        { id: 'room', name: '방 안 대화', kind: 'counter', exact: 1 },
        { id: 'sound', name: '소리 침입', kind: 'counter', max: 1 },
      ],
      elementMarks: { [a1.id]: { tags: [{ cat: 'sound' }] }, [a3.id]: { tags: [{ cat: 'sound' }] } },
    });
    expect(counterStatus(p).map((c) => [c.category.id, c.count, c.state])).toEqual([
      ['room', 0, 'under'],
      ['sound', 2, 'over'],
    ]);
    const codes = auditProject(p).map((x) => `${x.code}:${x.level}`);
    expect(codes).toContain('C10:fail');
    expect(codes).toContain('C10:warn');
  });

  it('keeps a motif ledger and flags a payoff without a setup', () => {
    const p = project(base, {
      tagCategories: [{ id: 'ring', name: '반지', kind: 'motif' }],
      elementMarks: { [a1.id]: { tags: [{ cat: 'ring', stage: 'payoff' }] }, [a3.id]: { tags: [{ cat: 'ring', stage: 'setup' }] } },
    });
    expect(motifLedger(p)[0].hits.map((h) => h.tag.stage)).toEqual(['payoff', 'setup']);
    const f = auditProject(p).filter((x) => x.code === 'C11');
    expect(f.map((x) => x.level).sort()).toEqual(['fail', 'warn']);
  });

  it('flags V.O. and banned words, except inside a play-within-the-play', () => {
    const vo = el('character', '민석 (V.O.)');
    const p = project([...base, vo, el('dialogue', '그날 밤.')], {
      auditOptions: { banVoiceOver: true, requireSceneCard: false },
      bannedWords: ['자유'],
    });
    expect(auditProject(p).map((x) => x.code).sort()).toEqual(['C8', 'C9']);
    const play = { ...p, elementMarks: { [d2.id]: { play: true } } };
    expect(auditProject(play).map((x) => x.code)).toEqual(['C8']);
    expect(auditProject(project([...base, el('character', '민석 (E)')], { auditOptions: { banVoiceOver: true, requireSceneCard: false } }))).toEqual([]);
  });
});

describe('locked expressions', () => {
  const marks = { [d2.id]: { locked: true } };
  const original = [s2, c2, d2];

  it('detects a locked element that was rewritten or removed', () => {
    expect(lockedChanged(original, [el('scene', s2.text), el('character', '세영'), el('dialogue', '나는 이제 자유야.')], marks)).toEqual([d2]);
    expect(lockedChanged(original, [el('scene', s2.text), el('action', '세영, 웃는다.'), el('character', '세영'), el('dialogue', d2.text)], marks)).toEqual([]);
  });

  it('carries original ids so marks survive acceptance', () => {
    const revised = carryIds(original, [el('scene', s2.text), el('action', '새 지문'), el('character', '세영'), el('dialogue', d2.text)]);
    expect(revised[0].id).toBe(s2.id);
    expect(revised[3].id).toBe(d2.id);
    expect(revised[1].id).not.toBe(a1.id);
  });

  it('reports a locked change in a revision audit', () => {
    const p = project(base, { elementMarks: marks });
    const revised = [el('scene', s2.text), el('character', '세영'), el('dialogue', '바뀐 대사')];
    expect(auditRevision(p, s2.id, revised).map((f) => f.code)).toEqual(['C2']);
    expect(auditRevision(p, s2.id, sceneElements(base, s2.id))).toEqual([]);
  });
});

describe('prompt context', () => {
  it('puts rulings first and marks locked and tagged elements', () => {
    const p = {
      ...project(base, {
        rulings: [{ id: 'r', code: 'R1', text: '세영은 행동의 주체다.' }],
        hardRules: [{ id: 'h', code: 'H3', text: '보이스오버 없음.' }],
        tagCategories: [{ id: 'ring', name: '반지', kind: 'motif' }],
        elementMarks: { [d2.id]: { locked: true }, [a1.id]: { tags: [{ cat: 'ring', stage: 'setup' }] } },
      }),
      id: 'p',
      rev: 1,
      createdAt: '',
      updatedAt: '',
    } as Project;
    const docs = documentsBlock(p, [{ id: 'f', projectId: 'p', kind: 'synopsis', title: '시놉시스', content: '하룻밤.', updatedAt: '' }]);
    expect(docs.indexOf('R1. 세영은 행동의 주체다.')).toBeLessThan(docs.indexOf('하룻밤.'));
    expect(docs).toContain('priority="최우선"');
    const bible = bibleBlock(p);
    expect(bible).toContain('H3. 보이스오버 없음.');
    expect(bible).toContain('<locked_expressions');
    expect(bible).toContain('- 반지: S#1 셋업');
    expect(formatElements([a1, d2], p)).toBe('[지문] 반지를 손에 쥔다.  {반지 — 셋업}\n[대사] 나는 자유야.  【확정】');
  });
});
