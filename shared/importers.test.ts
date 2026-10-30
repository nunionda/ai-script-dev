import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { docxParagraphs, fromParagraphs, fromText, hwpxParagraphs, importKind, pdfTextToParagraphs, unzip } from './importers';
import { toDocx } from './docx';
import { toHwpx } from './hwpx';
import { el } from './screenplay';
import type { ScriptElement } from './types';

const elements: ScriptElement[] = [
  el('scene', '내부. 로비 - 밤'),
  el('action', '로비는 어둡다.\n매표소에만 등이 켜져 있다.'),
  el('character', '동하'),
  el('parenthetical', '(낮게)'),
  el('dialogue', '왔냐.'),
  el('transition', '페이드 아웃.'),
];
const project = { title: '마지막 상영', author: '작가', contact: '', elements, format: 'korean' as const };
const shape = (els: { type: string; text: string }[]) => els.map((e) => [e.type, e.text]);

/** DEFLATE 항목이 든 zip (Word·한글이 실제로 만드는 형태) */
function deflatedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = new Uint8Array(deflateRawSync(raw));
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const c = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    locals.push(local, data);
    central.push(c);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...central, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('import', () => {
  it('reads stored and deflated zip entries', async () => {
    const files = await unzip(deflatedZip({ 'a.txt': '가나다 abc', 'b/c.xml': '<x/>' }));
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('가나다 abc');
    expect(new TextDecoder().decode(files.get('b/c.xml'))).toBe('<x/>');
  });

  it('round-trips our Word export by paragraph style', async () => {
    const r = fromParagraphs(await docxParagraphs(toDocx(project)));
    expect(r.title).toBe('마지막 상영');
    expect(shape(r.elements)).toEqual(shape(elements));
  });

  it('round-trips our 한글 export by paragraph style', async () => {
    const r = fromParagraphs(await hwpxParagraphs(toHwpx(project)));
    expect(shape(r.elements)).toEqual(shape(elements));
    const en = fromParagraphs(await hwpxParagraphs(toHwpx({ ...project, format: 'hollywood', elements: [el('scene', 'INT. LOBBY - NIGHT'), el('action', 'Dark.')] })));
    expect(shape(en.elements)).toEqual([['scene', 'INT. LOBBY - NIGHT'], ['action', 'Dark.']]);
  });

  it('reads a Word document without screenplay styles from a deflated zip', async () => {
    const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const doc =
      '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
      p('기획의도') + p('S#1. 내부. 방 - 밤') + p('철수가 창문을 연다.') + p('철수 : (작게) 왔어?') + p('영희: 응.') + p('컷') +
      '</w:body></w:document>';
    const r = fromParagraphs(await docxParagraphs(deflatedZip({ 'word/document.xml': doc })));
    expect(r.preface).toBe('기획의도');
    expect(shape(r.elements)).toEqual([
      ['scene', '내부. 방 - 밤'],
      ['action', '철수가 창문을 연다.'],
      ['character', '철수'],
      ['parenthetical', '(작게)'],
      ['dialogue', '왔어?'],
      ['character', '영희'],
      ['dialogue', '응.'],
      ['transition', '컷'],
    ]);
  });

  it('reads a Word script without blank lines, with acts and an appendix after it', async () => {
    const p = (t: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${t}</w:t></w:r></w:p>`;
    const doc =
      '<w:document xmlns:w="w"><w:body>' +
      p('로봇씨드', 'Title') + p('1막 떠나온 세계', 'Heading1') +
      p('01  외부 그린타워필드 낮', 'Heading2') + p('베티가 지나간다.') + p('스텔라') + p('공주님!') + p('베티는 숨는다.') + p('베티') + p('안녕.') + p('스텔라') + p('어디 가요?') +
      p('2막 선택', 'Heading1') + p('02  내부 코어실 밤', 'Heading2') + p('코어가 빛난다.') + p('03  외부 다리 밤', 'Heading2') + p('바람.') +
      p('장면 대조표', 'Heading1') + p('01 외부 그린타워필드 낮 유지') + p('02 내부 코어실 밤 압축') + p('03 외부 다리 밤 신설') +
      '</w:body></w:document>';
    const r = fromParagraphs(await docxParagraphs(deflatedZip({ 'word/document.xml': doc })));
    expect(r.acts.map((a) => a.title)).toEqual(['1막 떠나온 세계', '2막 선택']);
    expect(r.elements.filter((e) => e.type === 'scene').map((e) => e.text)).toEqual(['외부 그린타워필드 낮', '내부 코어실 밤', '외부 다리 밤']);
    expect(shape(r.elements.slice(0, 9))).toEqual([
      ['scene', '외부 그린타워필드 낮'],
      ['action', '베티가 지나간다.'],
      ['character', '스텔라'],
      ['dialogue', '공주님!'],
      ['action', '베티는 숨는다.'],
      ['character', '베티'],
      ['dialogue', '안녕.'],
      ['character', '스텔라'],
      ['dialogue', '어디 가요?'],
    ]);
    const scenes = r.elements.filter((e) => e.type === 'scene');
    expect(r.sceneMeta[scenes[0].id]?.act).toBe(r.acts[0].id);
    expect(r.sceneMeta[scenes[1].id]?.act).toBe(r.acts[1].id);
  });

  it('keeps table paragraphs out of the script', async () => {
    const doc =
      '<w:document xmlns:w="w"><w:body>' +
      '<w:p><w:r><w:t>S#1. 내부. 방 - 밤</w:t></w:r></w:p><w:p><w:r><w:t>창문이 열린다.</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>S#9. 외부. 표 안 - 낮</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>';
    const r = fromParagraphs(await docxParagraphs(deflatedZip({ 'word/document.xml': doc })));
    expect(shape(r.elements)).toEqual([['scene', '내부. 방 - 밤'], ['action', '창문이 열린다.']]);
    expect(r.preface).toContain('S#9. 외부. 표 안 - 낮');
  });

  it('classifies plain Korean and Hollywood text', () => {
    const ko = fromText('S#3. 외부. 골목 - 새벽\n\n서윤이 걷는다.\n\n동하\n(멀리서)\n서윤아!\n\n12 INT. HOUSE - DAY 12\n');
    expect(shape(ko.elements)).toEqual([
      ['scene', '외부. 골목 - 새벽'],
      ['action', '서윤이 걷는다.'],
      ['character', '동하'],
      ['parenthetical', '(멀리서)'],
      ['dialogue', '서윤아!'],
      ['scene', 'INT. HOUSE - DAY'],
    ]);
    const fountain = fromText('INT. ROOM - DAY\n\nShe waits.\n\nJOHN\nHello.\n');
    expect(shape(fountain.elements)).toEqual([['scene', 'INT. ROOM - DAY'], ['action', 'She waits.'], ['character', 'JOHN'], ['dialogue', 'Hello.']]);
  });

  it('uses indentation from PDF text to find cues and dialogue', () => {
    const item = (text: string, x: number, y: number, w = text.length * 6) => ({ text, x, y, w, size: 12 });
    const paras = pdfTextToParagraphs([
      {
        height: 800,
        items: [
          item('S#1. 내부. 방 - 밤', 100, 700),
          item('창문이 열려 있다. 바람이 분다.', 100, 680),
          item('커튼이 흔들린다.', 100, 666),
          item('동하', 250, 640),
          item('왔냐.', 170, 626),
          item('밥은 먹었고?', 170, 612),
          item('긴 지문 줄이 오른쪽 끝까지 이어진다고 가정하는 아주 긴 문장입니다.', 100, 590, 380),
          item('3', 480, 770),
        ],
      },
    ]);
    const r = fromParagraphs(paras);
    expect(shape(r.elements)).toEqual([
      ['scene', '내부. 방 - 밤'],
      ['action', '창문이 열려 있다. 바람이 분다. 커튼이 흔들린다.'],
      ['character', '동하'],
      ['dialogue', '왔냐. 밥은 먹었고?'],
      ['action', '긴 지문 줄이 오른쪽 끝까지 이어진다고 가정하는 아주 긴 문장입니다.'],
    ]);
    expect(() => pdfTextToParagraphs([{ height: 800, items: [] }])).toThrow(/스캔/);
  });

  it('detects the file kind', () => {
    expect(importKind('a.HWP', new Uint8Array())).toBe('hwp');
    expect(importKind('a.hwpx', new Uint8Array())).toBe('hwpx');
    expect(importKind('noext', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('pdf');
    expect(importKind('a.doc', new Uint8Array())).toBeNull();
  });
});
