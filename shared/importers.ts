import type { ElementType, ScriptElement } from './types';
import { el } from './screenplay';
import { fromFountain, type ImportedScript } from './fountain';

/*
 * Word(.docx) · 한글(.hwpx, .hwp) · PDF · 일반 텍스트 원고 가져오기.
 * 파일에서 문단(과 가능하면 문단 스타일·들여쓰기)을 뽑고, 시나리오 요소로 분류한다.
 * 분류는 휴리스틱이다 — 가져온 뒤 집필 화면에서 요소 종류를 고칠 수 있다.
 */

export interface Paragraph {
  text: string;
  /** 문단 스타일 이름 (docx·hwpx) */
  style?: string;
  /** 본문 폭 대비 왼쪽 들여쓰기 비율 0..1 (PDF) */
  indent?: number;
  /** 오른쪽 정렬 (PDF) */
  right?: boolean;
}

export interface ImportResult extends ImportedScript {
  /** 첫 씬 헤딩 앞의 내용 (기획의도·줄거리·등장인물 …) */
  preface: string;
}

// ---------------------------------------------------------------- zip

/** raw DEFLATE 풀기. 한글 본문 스트림은 압축 데이터 뒤에 남는 바이트가 있어, 거기서 나는 오류는 무시하고 푼 만큼 쓴다. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    if (!total) throw e;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** zip 항목을 모두 푼다 (STORE·DEFLATE) */
export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const compSize = view.getUint32(local + 18, true) || size;
    const raw = data.subarray(start, start + (method === 0 ? size : compSize));
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
}

// ---------------------------------------------------------------- docx

export async function docxParagraphs(data: Uint8Array): Promise<Paragraph[]> {
  const files = await unzip(data);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('Word 문서가 아닙니다.');
  const xml = new TextDecoder().decode(doc);
  // 스타일 id → 이름 (한국어 Word는 id가 숫자인 경우가 있다)
  const names = new Map<string, string>();
  const stylesXml = files.get('word/styles.xml');
  if (stylesXml) {
    for (const m of new TextDecoder().decode(stylesXml).matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="([^"]+)"/g)) names.set(m[1], m[2]);
  }
  const body = xml.slice(xml.indexOf('<w:body'));
  const out: Paragraph[] = [];
  for (const m of body.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[1] ?? '';
    const styleId = inner.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
    let text = '';
    for (const t of inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
      if (t[1] !== undefined) text += decodeEntities(t[1]);
      else text += t[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    out.push({ text, style: styleId ? (names.get(styleId) ?? styleId) : undefined });
  }
  return out;
}

// ---------------------------------------------------------------- hwpx

export async function hwpxParagraphs(data: Uint8Array): Promise<Paragraph[]> {
  const files = await unzip(data);
  const sections = [...files.keys()].filter((k) => /^Contents\/section\d+\.xml$/i.test(k)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!sections.length) throw new Error('한글(.hwpx) 문서가 아닙니다.');
  // 스타일 id → 이름
  const names = new Map<string, string>();
  const head = files.get('Contents/header.xml');
  if (head) for (const m of new TextDecoder().decode(head).matchAll(/<hh:style\b[^>]*\bid="(\d+)"[^>]*\bname="([^"]*)"/g)) names.set(m[1], decodeEntities(m[2]));
  const out: Paragraph[] = [];
  for (const name of sections) {
    const xml = new TextDecoder().decode(files.get(name));
    // 표 안의 문단도 차례로 펼친다
    let cur: Paragraph | null = null;
    let inText = 0;
    for (const m of xml.matchAll(/<(\/?)(?:\w+:)?(p|t|tab|lineBreak)\b([^>]*?)(\/?)>|([^<]+)/g)) {
      const [, close, tag, attrs, selfClose, text] = m;
      if (text !== undefined) {
        if (inText && cur) cur.text += decodeEntities(text);
        continue;
      }
      if (tag === 'p' && !close) {
        if (cur) out.push(cur);
        cur = { text: '', style: names.get(attrs.match(/styleIDRef="(\d+)"/)?.[1] ?? '') };
      } else if (tag === 'p' && close) {
        if (cur) out.push(cur);
        cur = null;
      } else if (tag === 't') {
        if (selfClose) continue;
        inText += close ? -1 : 1;
      } else if (cur && tag === 'tab') cur.text += '\t';
      else if (cur && tag === 'lineBreak') cur.text += '\n';
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- hwp 5.0 (복합 파일)

/** 복합 파일(CFB)에서 경로별 스트림을 읽는다 */
function readCfb(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0xe011cfd0 || view.getUint32(4, true) !== 0xe11ab1a1) throw new Error('한글(.hwp) 문서가 아닙니다.');
  const sectorSize = 1 << view.getUint16(30, true);
  const miniSize = 1 << view.getUint16(32, true);
  const sector = (n: number) => 512 + n * sectorSize;
  const ENDCHAIN = 0xfffffffe;

  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = view.getUint32(76 + i * 4, true);
    if (s < 0xfffffffa) fatSectors.push(s);
  }
  for (let d = view.getUint32(68, true), guard = 0; d < 0xfffffffa && guard < 10000; guard++) {
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const s = view.getUint32(sector(d) + i * 4, true);
      if (s < 0xfffffffa) fatSectors.push(s);
    }
    d = view.getUint32(sector(d) + per * 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32(sector(s) + i * 4, true));

  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start, guard = 0; s !== ENDCHAIN && s < table.length && guard < 1_000_000; guard++) {
      out.push(s);
      s = table[s];
    }
    return out;
  };
  const readChain = (start: number) => {
    const parts = chain(start, fat).map((s) => data.subarray(sector(s), sector(s) + sectorSize));
    const buf = new Uint8Array(parts.length * sectorSize);
    parts.forEach((p, i) => buf.set(p, i * sectorSize));
    return buf;
  };

  const dir = readChain(view.getUint32(48, true));
  const dv = new DataView(dir.buffer);
  const entries: { name: string; type: number; left: number; right: number; child: number; start: number; size: number }[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dv.getUint16(off + 64, true);
    let name = '';
    for (let i = 0; i < Math.max(0, nameLen / 2 - 1); i++) name += String.fromCharCode(dv.getUint16(off + i * 2, true));
    entries.push({
      name,
      type: dir[off + 66],
      left: dv.getUint32(off + 68, true),
      right: dv.getUint32(off + 72, true),
      child: dv.getUint32(off + 76, true),
      start: dv.getUint32(off + 116, true),
      size: dv.getUint32(off + 120, true),
    });
  }
  const root = entries[0];
  const miniStream = readChain(root.start);
  const miniFat: number[] = [];
  const miniFatBytes = view.getUint32(64, true) ? readChain(view.getUint32(60, true)) : new Uint8Array();
  const mv = new DataView(miniFatBytes.buffer);
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mv.getUint32(i, true));
  const cutoff = view.getUint32(56, true);

  const out = new Map<string, Uint8Array>();
  const walk = (id: number, prefix: string, guard = 0) => {
    if (id >= entries.length || id === 0xffffffff || guard > 10000) return;
    const e = entries[id];
    walk(e.left, prefix, guard + 1);
    walk(e.right, prefix, guard + 1);
    const path = prefix + e.name;
    if (e.type === 1) walk(e.child, `${path}/`, guard + 1);
    else if (e.type === 2) {
      if (e.size < cutoff) {
        const parts = chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize));
        const buf = new Uint8Array(parts.length * miniSize);
        parts.forEach((p, i) => buf.set(p, i * miniSize));
        out.set(path, buf.subarray(0, e.size));
      } else out.set(path, readChain(e.start).subarray(0, e.size));
    }
  };
  walk(root.child, '');
  return out;
}

const HWPTAG_PARA_HEADER = 66;
const HWPTAG_PARA_TEXT = 67;

/** 문단 글자의 제어 문자: 확장·인라인 제어는 8글자(16바이트)를 차지한다 */
function paraText(rec: Uint8Array): string {
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  let s = '';
  for (let i = 0; i + 1 < rec.length; ) {
    const c = v.getUint16(i, true);
    if (c >= 32) {
      s += String.fromCharCode(c);
      i += 2;
    } else if (c === 9) {
      s += '\t';
      i += 16;
    } else if (c === 10) {
      s += '\n';
      i += 2;
    } else if (c === 13) break;
    else if ((c >= 1 && c <= 8) || c === 11 || c === 12 || (c >= 14 && c <= 23)) i += 16;
    else i += 2;
  }
  return s;
}

export async function hwpParagraphs(data: Uint8Array): Promise<Paragraph[]> {
  const files = readCfb(data);
  const header = files.get('FileHeader');
  if (!header || new TextDecoder().decode(header.subarray(0, 17)) !== 'HWP Document File') throw new Error('한글(.hwp) 문서가 아닙니다.');
  const flags = new DataView(header.buffer, header.byteOffset).getUint32(36, true);
  if (flags & 0b10) throw new Error('암호가 걸린 한글 문서는 가져올 수 없습니다. 한글에서 암호를 풀고 다시 시도해 주세요.');
  if (flags & 0b100) throw new Error('배포용 한글 문서는 가져올 수 없습니다. 한글에서 일반 문서로 저장한 뒤 다시 시도해 주세요.');
  const compressed = Boolean(flags & 1);
  const sections = [...files.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]));
  const out: Paragraph[] = [];
  for (const name of sections) {
    const body = compressed ? await inflateRaw(files.get(name)!) : files.get(name)!;
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let p = 0; p + 4 <= body.length; ) {
      const h = v.getUint32(p, true);
      const tag = h & 0x3ff;
      let size = h >>> 20;
      p += 4;
      if (size === 0xfff) {
        size = v.getUint32(p, true);
        p += 4;
      }
      if (tag === HWPTAG_PARA_HEADER) out.push({ text: '' });
      else if (tag === HWPTAG_PARA_TEXT && out.length) out[out.length - 1].text = paraText(body.subarray(p, p + size));
      p += size;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 문단 → 시나리오 요소

const STYLE_TYPE: [RegExp, ElementType][] = [
  [/^(scene ?heading|씬 ?헤딩|장면 ?제목|scene|slug)/i, 'scene'],
  [/^(action|description|지문)/i, 'action'],
  [/^(character|인물|배역)/i, 'character'],
  [/^(parenthetical|괄호)/i, 'parenthetical'],
  [/^(dialog(ue)?|대사)/i, 'dialogue'],
  [/^(transition|전환)/i, 'transition'],
  [/^(shot|샷)/i, 'shot'],
];

const PLACE = String.raw`(?:INT|EXT|EST|I\/E|내부|외부|실내|실외|내\/외)`;
/** 씬 헤딩: "S#12.", "씬 12", "#12", "12. INT.", "12 외부.", "INT. …", "내부. …" */
const SCENE_RE = new RegExp(String.raw`^\s*(?:(?:S\s*#|씬|scene|#)\s*\d+(?:-\d+|[A-Z])?\s*[.):]?\s*|\d+(?:-\d+|[A-Z])?(?:\s*[.)]\s*|\s+)(?=${PLACE}[.\s])|(?:INT|EXT|EST|INT\.?\/EXT|I\/E|내부|외부|실내|실외|내\/외)[.\s])`, 'i');
const SCENE_NUMBER_RE = new RegExp(String.raw`^\s*(?:(?:S\s*#|씬|scene|#)\s*\d+(?:-\d+|[A-Z])?\s*[.):]?\s*|\d+(?:-\d+|[A-Z])?(?:\s*[.)]\s*|\s+)(?=${PLACE}[.\s]))`, 'i');
const TRANSITION_RE = /^(?:(?:CUT|SMASH CUT|MATCH CUT|DISSOLVE|FADE)(?: (?:TO|IN|OUT))?[:.]?|FADE (?:IN|OUT)[:.]?|.+ TO:|(?:컷|페이드\s?(?:인|아웃)|디졸브|암전|F\.?\s?[IO]\.?|O\.?L\.?|C\.?\s?I\.?|C\.?\s?O\.?)\s*[.:]?)$/i;
const CUE_EXT = /\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|E|F|CONT'D|소리|목소리|전화|이어서)\)\s*$/i;
/** "이름 : 대사", "이름: (괄호) 대사" — 한국 원고에서 흔한 형태 */
const INLINE_DIALOGUE_RE = /^([가-힣A-Za-z0-9·]{1,12}(?: [가-힣A-Za-z0-9·]{1,10})?(?:\s?\((?:V\.?O\.?|O\.?S\.?|E|F|소리|목소리|전화)\))?)\s*[:：]\s*(?:(\([^)]*\))\s*)?(.+)$/;

function looksLikeCue(text: string, next: string | undefined): boolean {
  const t = text.trim().replace(CUE_EXT, '');
  if (!t || !next?.trim() || t.length > 24) return false;
  if (/[.,!?。…"'“”‘’~:]$/.test(t) || /[.,!?]/.test(t)) return false;
  // 영문: 대문자 이름
  if (/[A-Za-z]/.test(t)) return t === t.toUpperCase() && !/[가-힣]/.test(t);
  // 한글: 공백 없는 짧은 이름 (예: 동하, 서윤, 형사1)
  return /^[가-힣0-9·]{1,8}$/.test(t);
}

/** 문단 목록을 시나리오 요소로 분류한다 */
export function fromParagraphs(paras: Paragraph[]): ImportResult {
  const result: ImportResult = { title: '', author: '', contact: '', elements: [], acts: [], sceneMeta: {}, preface: '' };
  // 줄을 맞추려고 넣은 연속 공백은 하나로 (탭은 이름·대사 구분에 쓰므로 둔다)
  const clean = paras.map((p) => ({ ...p, text: p.text.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/ {2,}/g, ' ').replace(/[ \t]+$/gm, '') }));
  const styled = clean.filter((p) => p.style && STYLE_TYPE.some(([re]) => re.test(p.style!))).length;
  const useStyles = styled >= Math.max(3, clean.filter((p) => p.text.trim()).length * 0.3);

  const firstScene = clean.findIndex((p) => {
    if (useStyles && p.style) return STYLE_TYPE.find(([re]) => re.test(p.style!))?.[1] === 'scene';
    return SCENE_RE.test(p.text.trim());
  });
  const preface = firstScene > 0 ? clean.slice(0, firstScene) : [];
  const body = firstScene >= 0 ? clean.slice(firstScene) : clean;
  const prefaceLines = preface.map((p) => p.text.trim()).filter((t) => t && !/^\d+\.?$/.test(t));
  result.title = prefaceLines[0]?.slice(0, 200) ?? '';
  result.preface = prefaceLines.join('\n');

  const push = (type: ElementType, text: string) => {
    const e = el(type, text);
    result.elements.push(e);
    return e;
  };
  const last = (): ScriptElement | undefined => result.elements[result.elements.length - 1];
  // 앞의 장면 번호를 떼고, 할리우드 원고의 오른쪽 장면 번호("INT. ROOM - DAY 12")도 뗀다
  const heading = (t: string) => {
    const h = t.replace(SCENE_NUMBER_RE, '').trim() || t.trim();
    return /^(INT|EXT|EST|I\/E)/i.test(h) ? h.replace(/\s+\d+[A-Z]?\.?$/, '') : h;
  };

  let inDialogue = false;
  for (let i = 0; i < body.length; i++) {
    const p = body[i];
    const text = p.text.trim();
    if (!text) {
      inDialogue = false;
      continue;
    }
    // 쪽 번호·머리말 흔적
    if (/^\d+\.?$/.test(text) || /^-\s*\d+\s*-$/.test(text) || /^\(?(MORE|계속)\)?$/i.test(text)) continue;

    if (useStyles && p.style) {
      const type = STYLE_TYPE.find(([re]) => re.test(p.style!))?.[1];
      if (type) {
        push(type, type === 'scene' ? heading(text) : text);
        continue;
      }
    }

    if (SCENE_RE.test(text) && !text.includes('\n')) {
      push('scene', heading(text));
      inDialogue = false;
      continue;
    }
    if (TRANSITION_RE.test(text) || (p.right && /:$/.test(text))) {
      push('transition', text);
      inDialogue = false;
      continue;
    }

    // 들여쓰기 정보가 있으면 (PDF) 위치로 판단
    if (p.indent !== undefined) {
      if (p.indent >= 0.3 && p.indent < 0.6 && looksLikeCue(text, body[i + 1]?.text)) {
        push('character', text);
        inDialogue = true;
        continue;
      }
      if (inDialogue && p.indent >= 0.1) {
        if (/^\(.*\)$/s.test(text)) push('parenthetical', text);
        else if (last()?.type === 'dialogue') last()!.text += `\n${text}`;
        else push('dialogue', text);
        continue;
      }
      inDialogue = false;
      const inlineCue = text.match(INLINE_DIALOGUE_RE);
      if (inlineCue) {
        push('character', inlineCue[1].trim());
        if (inlineCue[2]) push('parenthetical', inlineCue[2]);
        push('dialogue', inlineCue[3].trim());
        continue;
      }
      push('action', text);
      continue;
    }

    const inline = text.match(INLINE_DIALOGUE_RE);
    if (inline && !SCENE_RE.test(text)) {
      push('character', inline[1].trim());
      if (inline[2]) push('parenthetical', inline[2]);
      push('dialogue', inline[3].trim());
      inDialogue = false;
      continue;
    }
    // 탭으로 이름과 대사를 나눈 원고
    const tab = text.match(/^([가-힣A-Za-z0-9·]{1,12})\t+(?:(\([^)]*\))\s*)?(.+)$/s);
    if (tab) {
      push('character', tab[1]);
      if (tab[2]) push('parenthetical', tab[2]);
      push('dialogue', tab[3].trim());
      inDialogue = false;
      continue;
    }
    if (looksLikeCue(text, body[i + 1]?.text) && !inDialogue) {
      push('character', text);
      inDialogue = true;
      continue;
    }
    if (inDialogue) {
      if (/^\(.*\)$/s.test(text)) push('parenthetical', text);
      else if (last()?.type === 'dialogue') last()!.text += `\n${text}`;
      else push('dialogue', text);
      continue;
    }
    push('action', text);
  }
  return result;
}

// ---------------------------------------------------------------- 파일 → 원고

export type ImportKind = 'fdx' | 'fountain' | 'docx' | 'hwpx' | 'hwp' | 'pdf' | 'txt';

export function importKind(name: string, head: Uint8Array): ImportKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'fdx') return 'fdx';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (ext === 'docx') return 'docx';
  if (ext === 'hwpx') return 'hwpx';
  if (ext === 'hwp') return 'hwp';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt') return 'txt';
  // 확장자가 없으면 내용으로
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
  if (head[0] === 0xd0 && head[1] === 0xcf) return 'hwp';
  return null;
}

/** 일반 텍스트: Fountain 형식이면 Fountain으로, 아니면 문단 휴리스틱으로 */
export function fromText(text: string): ImportResult {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fountainLike = /^(?:INT|EXT|EST|I\/E)[.\s]/m.test(normalized) && /\n\s*\n/.test(normalized) && !/^\s*S\s*#\s*\d+/m.test(normalized);
  if (fountainLike) return { ...fromFountain(normalized), preface: '' };
  return fromParagraphs(normalized.split('\n').map((line) => ({ text: line })));
}

export async function importBinary(kind: 'docx' | 'hwpx' | 'hwp', data: Uint8Array): Promise<ImportResult> {
  const paras = kind === 'docx' ? await docxParagraphs(data) : kind === 'hwpx' ? await hwpxParagraphs(data) : await hwpParagraphs(data);
  return fromParagraphs(paras);
}

// ---------------------------------------------------------------- PDF 글자 조각 → 문단

export interface PdfPage {
  height: number;
  items: { text: string; x: number; y: number; w: number; size: number }[];
}

interface PdfLine {
  y: number;
  x: number;
  right: number;
  size: number;
  text: string;
}

/**
 * 시나리오 PDF는 들여쓰기로 인물·대사가 갈리므로 본문 폭 대비 왼쪽 위치(indent)를 함께 넘긴다.
 * 줄 간격이 좁고 들여쓰기가 같은 줄은 한 문단으로 잇는다.
 */
export function pdfTextToParagraphs(pages: PdfPage[]): Paragraph[] {
  const out: Paragraph[] = [];
  let chars = 0;
  for (const page of pages) {
    const items = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: PdfLine[] = [];
    for (const it of items) {
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(cur.y - it.y) <= it.size * 0.4) {
        const gap = it.x - cur.right;
        cur.text += (gap > it.size * 0.2 && !cur.text.endsWith(' ') ? ' ' : '') + it.text;
        cur.right = Math.max(cur.right, it.x + it.w);
      } else lines.push({ y: it.y, x: it.x, right: it.x + it.w, size: it.size, text: it.text });
    }
    // 머리말·꼬리말의 쪽 번호 ("12." / "제목 / 12")
    const body = lines.filter((l) => !((l.y > page.height * 0.9 || l.y < page.height * 0.07) && /(^|\/\s*)\d+\.?$/.test(l.text.trim()) && l.text.length < 60));
    if (!body.length) continue;
    chars += body.reduce((a, l) => a + l.text.length, 0);

    const xs = body.map((l) => l.x).sort((a, b) => a - b);
    const left = xs[Math.floor(xs.length * 0.1)];
    const rightEdge = Math.max(...body.map((l) => l.right));
    const width = Math.max(1, rightEdge - left);
    const gaps = body
      .slice(1)
      .map((l, i) => body[i].y - l.y)
      .filter((g) => g > 0)
      .sort((a, b) => a - b);
    const lineGap = gaps[Math.floor(gaps.length * 0.3)] ?? 14;

    let prev: PdfLine | null = null;
    for (const l of body) {
      const indent = Math.max(0, (l.x - left) / width);
      const gap = prev ? prev.y - l.y : Infinity;
      const sameColumn = prev !== null && Math.abs(prev.x - l.x) < width * 0.03;
      // 오른쪽 끝까지 찬 줄은 다음 줄로 이어진다 (내어쓰기한 "이름: 대사"의 둘째 줄 등)
      const prevFull = prev !== null && prev.right >= rightEdge - width * 0.08 && l.x >= left - width * 0.02;
      const cur = out[out.length - 1];
      if (prev && cur?.text && gap <= lineGap * 1.35 && (sameColumn || prevFull) && !/^\(/.test(l.text.trim()) && !SCENE_RE.test(l.text.trim()) && !INLINE_DIALOGUE_RE.test(l.text.trim())) {
        cur.text += ` ${l.text.trim()}`;
      } else {
        if (prev && gap > lineGap * 1.35) out.push({ text: '' });
        out.push({ text: l.text.trim(), indent, right: l.right >= rightEdge - width * 0.02 && indent > 0.5 });
      }
      prev = l;
    }
    out.push({ text: '' });
  }
  if (!chars) throw new Error('글자가 없는 PDF입니다. 스캔한 원고는 가져올 수 없습니다.');
  return out;
}
