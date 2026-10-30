import type { Act, ElementType, Project, ScriptElement, SceneMeta } from './types';
import { el, uid } from './screenplay';

export interface ImportedScript {
  title: string;
  author: string;
  contact: string;
  elements: ScriptElement[];
  acts: Act[];
  sceneMeta: Record<string, SceneMeta>;
}

const HEADING_RE = /^(INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E)[.\s]/i;
const KOREAN_HEADING_RE = /^(S#\s*\d+\s*[.)]?\s*|(내부|외부|내\/외|내부\/외부)[.\s])/;

function hasLetters(s: string): boolean {
  return /[A-Za-z]/.test(s);
}
function isUpper(s: string): boolean {
  return hasLetters(s) && s === s.toUpperCase();
}

// ---------------------------------------------------------------- export

export function toFountain(project: Pick<Project, 'title' | 'author' | 'contact' | 'elements' | 'acts' | 'sceneMeta'>): string {
  const out: string[] = [];
  if (project.title) out.push(`Title: ${project.title}`);
  if (project.author) out.push(`Author: ${project.author}`);
  if (project.contact) out.push(`Contact: ${project.contact}`);
  if (out.length) out.push('');

  const actTitle = new Map(project.acts.map((a) => [a.id, a.title]));
  let lastAct = '';
  let prev: ElementType | null = null;
  for (const e of project.elements) {
    const meta = e.type === 'scene' ? project.sceneMeta[e.id] : undefined;
    let actHeader = '';
    if (meta?.act && meta.act !== lastAct && actTitle.has(meta.act)) {
      actHeader = actTitle.get(meta.act)!;
      lastAct = meta.act;
    } else if (e.type === 'scene' && !lastAct && project.acts.length) {
      actHeader = project.acts[0].title;
      lastAct = project.acts[0].id;
    }
    if (actHeader) {
      if (prev) out.push('');
      out.push(`# ${actHeader}`, '');
    }
    const inDialogue = e.type === 'dialogue' || e.type === 'parenthetical';
    if (prev && !actHeader && !(inDialogue && (prev === 'character' || prev === 'dialogue' || prev === 'parenthetical'))) out.push('');
    out.push(fountainLine(e));
    if (meta?.synopsis) out.push('', `= ${meta.synopsis.replace(/\n/g, ' ')}`);
    prev = e.type;
  }
  return out.join('\n') + '\n';
}

function fountainLine(e: ScriptElement): string {
  const t = e.text;
  switch (e.type) {
    case 'scene':
      return HEADING_RE.test(t) ? t.toUpperCase() : `.${t}`;
    case 'character':
      return isUpper(t.toUpperCase()) && !/[^\x00-\x7F]/.test(t) ? t.toUpperCase() : `@${t}`;
    case 'parenthetical': {
      const s = t.trim();
      return s.startsWith('(') ? s : `(${s})`;
    }
    case 'dialogue':
      return t;
    case 'transition':
      return /TO:$/.test(t.toUpperCase()) && !/[^\x00-\x7F]/.test(t) ? t.toUpperCase() : `> ${t}`;
    case 'shot':
      return `!${t.toUpperCase()}`;
    default: {
      // 지문이 다른 요소로 오인되지 않도록 강제 표시
      const first = t.split('\n')[0];
      if (HEADING_RE.test(first) || isUpper(first) || /^[.@>!#=~[]/.test(first)) return `!${t}`;
      return t;
    }
  }
}

// ---------------------------------------------------------------- import

export function fromFountain(source: string): ImportedScript {
  let text = source.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');

  const result: ImportedScript = { title: '', author: '', contact: '', elements: [], acts: [], sceneMeta: {} };

  // 타이틀 페이지
  const lines = text.split('\n');
  if (/^[A-Za-z ]+:/.test(lines[0] ?? '')) {
    let i = 0;
    let key = '';
    const fields: Record<string, string[]> = {};
    for (; i < lines.length && lines[i].trim() !== ''; i++) {
      const m = lines[i].match(/^([A-Za-z ]+):\s*(.*)$/);
      if (m && !/^\s/.test(lines[i])) {
        key = m[1].trim().toLowerCase();
        fields[key] = m[2] ? [m[2]] : [];
      } else if (key) fields[key].push(lines[i].trim());
    }
    result.title = (fields['title'] ?? []).join(' ').replace(/[*_]/g, '').trim();
    result.author = (fields['author'] ?? fields['authors'] ?? fields['credit'] ?? []).join(' ').trim();
    result.contact = (fields['contact'] ?? []).join(', ').trim();
    text = lines.slice(i).join('\n');
  }

  const paragraphs = text.split(/\n[ \t]*\n/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim() !== '');
  let pendingAct: Act | null = null;
  let lastScene: ScriptElement | null = null;

  const push = (type: ElementType, value: string) => {
    const e = el(type, value);
    result.elements.push(e);
    return e;
  };

  for (const para of paragraphs) {
    const pLines = para.split('\n');
    const first = pLines[0].trim();

    if (/^#+\s*/.test(first) && !/^#\d/.test(first)) {
      const title = first.replace(/^#+\s*/, '').trim();
      pendingAct = { id: uid('a'), title };
      result.acts.push(pendingAct);
      continue;
    }
    if (/^=(?!==)/.test(first)) {
      if (lastScene) {
        const meta = (result.sceneMeta[lastScene.id] ??= {});
        meta.synopsis = [meta.synopsis, first.replace(/^=\s*/, '')].filter(Boolean).join(' ');
      }
      continue;
    }
    if (/^={3,}$/.test(first)) continue; // 페이지 나눔

    // 씬 헤딩
    if (pLines.length === 1 && ((/^\.[^.]/.test(first)) || HEADING_RE.test(first) || KOREAN_HEADING_RE.test(first))) {
      let h = first.startsWith('.') ? first.slice(1) : first;
      h = h.replace(/\s*#[^#]+#\s*$/, '').replace(/^S#\s*\d+\s*[.)]?\s*/, '').trim();
      lastScene = push('scene', h);
      if (pendingAct) {
        result.sceneMeta[lastScene.id] = { act: pendingAct.id };
        pendingAct = null;
      }
      continue;
    }
    // 전환
    if (pLines.length === 1 && first.startsWith('>') && !first.endsWith('<')) {
      push('transition', first.slice(1).trim());
      continue;
    }
    if (pLines.length === 1 && isUpper(first) && /TO:$/.test(first)) {
      push('transition', first);
      continue;
    }
    // 대사 블록
    const charLine = first.startsWith('@') ? first.slice(1).trim() : !first.startsWith('!') && isUpper(first.replace(/\(.*?\)/g, '')) && pLines.length > 1 ? first : null;
    if (charLine !== null) {
      push('character', charLine.replace(/\s*\^$/, ''));
      for (const raw of pLines.slice(1)) {
        const l = raw.trim();
        if (!l) continue;
        if (/^\(.*\)$/.test(l)) push('parenthetical', l);
        else {
          const last = result.elements[result.elements.length - 1];
          if (last.type === 'dialogue') last.text += '\n' + l;
          else push('dialogue', l);
        }
      }
      continue;
    }
    // 가운데 정렬 지문 / 지문
    let body = para;
    if (body.startsWith('!')) body = body.slice(1);
    body = body.replace(/^>\s*(.*?)\s*<$/gm, '$1');
    push('action', body.split('\n').map((l) => l.replace(/^\s+/, '')).join('\n'));
  }

  // 막이 정의되었는데 첫 장면에 막이 없으면 첫 막을 지정
  if (result.acts.length) {
    const firstScene = result.elements.find((e) => e.type === 'scene');
    if (firstScene && !result.sceneMeta[firstScene.id]?.act) (result.sceneMeta[firstScene.id] ??= {}).act = result.acts[0].id;
  }
  return result;
}

/**
 * 모델이 장면 전체를 요소 하나에 시나리오 텍스트로 몰아 쓰는 경우가 있다.
 * 빈 줄로 나뉜 여러 문단이 든 요소는 Fountain 규칙으로 다시 나눈다. 첫 조각은 원래 요소 종류를 지킨다.
 */
export function expandRuns<T extends { type: ElementType; text: string }>(elements: T[]): { type: ElementType; text: string }[] {
  return elements.flatMap((e) => {
    if (!/\n\s*\n/.test(e.text)) return [{ type: e.type, text: e.text }];
    const parts = fromFountain(e.text).elements.map((x) => ({ type: x.type, text: x.text }));
    if (!parts.length) return [{ type: e.type, text: e.text }];
    if (e.type === 'scene' && parts[0].type !== 'scene') parts[0] = { ...parts[0], type: 'scene' };
    return parts;
  });
}
