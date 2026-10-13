import type { ElementType, ScriptElement } from './types';
import { displayText } from './screenplay';

/**
 * 업계 표준 서식(Courier 12pt, 10cpi, 페이지당 약 55줄)을 기준으로 한 페이지 계산.
 * 한글 등 전각 문자는 2칸으로 센다.
 */
export const LINES_PER_PAGE = 55;

export const LAYOUT: Record<ElementType, { width: number; before: number }> = {
  scene: { width: 60, before: 2 },
  action: { width: 60, before: 1 },
  character: { width: 38, before: 1 },
  parenthetical: { width: 25, before: 0 },
  dialogue: { width: 35, before: 0 },
  transition: { width: 20, before: 1 },
  shot: { width: 60, before: 1 },
  general: { width: 60, before: 1 },
};

export function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)
  )
    return 2;
  return 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 단어 단위 줄바꿈. 너비를 넘는 단어는 강제로 자른다. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    let lineW = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = textWidth(word);
      if (lineW && lineW + 1 + w <= width) {
        line += ' ' + word;
        lineW += 1 + w;
        continue;
      }
      if (lineW) out.push(line);
      line = '';
      lineW = 0;
      let rest = word;
      while (w > width) {
        let cut = '';
        let cw = 0;
        for (const ch of rest) {
          if (cw + charWidth(ch) > width) break;
          cut += ch;
          cw += charWidth(ch);
        }
        out.push(cut);
        rest = rest.slice(cut.length);
        w = textWidth(rest);
      }
      line = rest;
      lineW = w;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

export function elementLines(e: ScriptElement): number {
  return wrapText(displayText(e), LAYOUT[e.type].width).length;
}

export interface Pagination {
  pageCount: number;
  /** 요소 id → 시작 페이지 (1부터) */
  pageOf: Map<string, number>;
  /** 새 페이지를 시작하는 요소 id (첫 페이지 제외) → 페이지 번호 */
  breaks: Map<string, number>;
  /** 장면 id → 1/8 페이지 단위 길이 */
  sceneEighths: Map<string, number>;
}

interface Block {
  items: { e: ScriptElement; lines: number }[];
  before: number;
  /** 분할 가능 여부 (긴 지문·대사 묶음) */
  splittable: boolean;
}

function buildBlocks(elements: ScriptElement[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < elements.length) {
    const e = elements[i];
    if (e.type === 'character') {
      const items = [{ e, lines: elementLines(e) }];
      let j = i + 1;
      while (j < elements.length && (elements[j].type === 'dialogue' || elements[j].type === 'parenthetical')) {
        items.push({ e: elements[j], lines: elementLines(elements[j]) });
        j++;
      }
      const total = items.reduce((a, b) => a + b.lines, 0);
      blocks.push({ items, before: LAYOUT.character.before, splittable: total > 12 });
      i = j;
      continue;
    }
    if (e.type === 'scene' && i + 1 < elements.length && elements[i + 1].type !== 'scene') {
      // 씬 헤딩은 다음 요소와 함께 넘긴다 (페이지 하단에 헤딩만 남지 않도록)
      const next = elements[i + 1];
      if (next.type === 'character') {
        blocks.push({ items: [{ e, lines: elementLines(e) }], before: LAYOUT.scene.before, splittable: false });
        i++;
        continue;
      }
      blocks.push({
        items: [
          { e, lines: elementLines(e) },
          { e: next, lines: elementLines(next) },
        ],
        before: LAYOUT.scene.before,
        splittable: elementLines(next) > 6,
      });
      i += 2;
      continue;
    }
    const lines = elementLines(e);
    blocks.push({ items: [{ e, lines }], before: LAYOUT[e.type].before, splittable: lines > 6 });
    i++;
  }
  return blocks;
}

export function paginate(elements: ScriptElement[]): Pagination {
  const pageOf = new Map<string, number>();
  const breaks = new Map<string, number>();
  const lineStart = new Map<string, number>();
  let page = 1;
  let used = 0;

  const newPage = (id: string) => {
    page++;
    used = 0;
    breaks.set(id, page);
  };

  for (const block of buildBlocks(elements)) {
    const total = block.items.reduce((a, b) => a + b.lines, 0) + (block.items.length > 1 && block.items[0].e.type === 'scene' ? 1 : 0);
    const before = used === 0 ? 0 : block.before;
    if (used + before + total > LINES_PER_PAGE && used > 0) {
      const room = LINES_PER_PAGE - used - before;
      if (!block.splittable || room < 3) {
        newPage(block.items[0].e.id);
      }
    }
    if (used > 0) used += block.before;
    block.items.forEach((item, idx) => {
      if (idx > 0 && item.e.type !== 'dialogue' && item.e.type !== 'parenthetical') used += 1; // 헤딩 뒤 빈 줄
      if (used >= LINES_PER_PAGE) newPage(item.e.id);
      pageOf.set(item.e.id, page);
      lineStart.set(item.e.id, (page - 1) * LINES_PER_PAGE + used);
      let lines = item.lines;
      while (used + lines > LINES_PER_PAGE) {
        lines -= LINES_PER_PAGE - used;
        page++;
        used = 0;
      }
      used += lines;
    });
  }

  const sceneEighths = new Map<string, number>();
  const sceneStarts = elements.filter((e) => e.type === 'scene').map((e) => ({ id: e.id, line: lineStart.get(e.id) ?? 0 }));
  const endLine = (page - 1) * LINES_PER_PAGE + used;
  sceneStarts.forEach((s, idx) => {
    const end = idx + 1 < sceneStarts.length ? sceneStarts[idx + 1].line : endLine;
    sceneEighths.set(s.id, Math.max(1, Math.round(((end - s.line) / LINES_PER_PAGE) * 8)));
  });

  return { pageCount: elements.length ? page : 0, pageOf, breaks, sceneEighths };
}

export function formatEighths(eighths: number): string {
  const pages = Math.floor(eighths / 8);
  const rest = eighths % 8;
  if (!pages) return `${rest}/8`;
  return rest ? `${pages} ${rest}/8` : `${pages}`;
}
