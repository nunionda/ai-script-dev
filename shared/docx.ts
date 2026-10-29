import type { ElementType, Project } from './types';

// Word(.docx) 내보내기. 인쇄용 원고(PrintView)와 같은 여백·들여쓰기·표지를 OOXML로 옮긴다.
// 요소마다 같은 이름의 단락 스타일을 만들어 Word에서도 서식을 고쳐 쓸 수 있게 한다.

type DocxProject = Pick<Project, 'title' | 'author' | 'contact' | 'elements' | 'format'>;

const TWIP = 1440; // 1인치
const PAGE = {
  korean: { w: 11906, h: 16838 }, // A4
  hollywood: { w: 12240, h: 15840 }, // US Letter
};
const MARGIN = { top: TWIP, bottom: Math.round(0.8 * TWIP), left: Math.round(1.5 * TWIP), right: TWIP };
const LINE = 240; // 12pt 한 줄

const STYLE_NAME: Record<ElementType, string> = {
  scene: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  transition: 'Transition',
  shot: 'Shot',
  general: 'General',
};

function styleId(type: ElementType): string {
  return STYLE_NAME[type].replace(/\s/g, '');
}

function esc(s: string): string {
  // XML 1.0에서 허용되지 않는 제어 문자는 버린다.
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runs(text: string, rPr = ''): string {
  return text
    .split('\n')
    .map((line, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join('');
}

function styles(format: DocxProject['format']): string {
  const textWidth = PAGE[format].w - MARGIN.left - MARGIN.right;
  const pct = (n: number) => Math.round((textWidth * n) / 100);
  // 원고 화면(.el-*)의 비율을 그대로 쓴다: 왼쪽 들여쓰기 %, 폭 %.
  const spec: Record<ElementType, { left?: number; width?: number; before: number; pPr?: string; rPr?: string }> = {
    scene: { before: 2 * LINE, pPr: '<w:keepNext/>', rPr: '<w:b/><w:caps/>' },
    action: { before: LINE },
    character: { left: 37, before: LINE, pPr: '<w:keepNext/>', rPr: '<w:b/><w:caps/>' },
    parenthetical: { left: 27, width: 40, before: 0, pPr: '<w:keepNext/>' },
    dialogue: { left: 17, width: 58, before: 0, pPr: '<w:keepLines/>' },
    transition: { before: LINE, pPr: '<w:jc w:val="right"/>', rPr: '<w:caps/>' },
    shot: { before: LINE, rPr: '<w:caps/>' },
    general: { before: LINE },
  };
  const paragraphStyles = (Object.keys(spec) as ElementType[]).map((type) => {
    const s = spec[type];
    const left = s.left ? pct(s.left) : 0;
    const right = s.width ? textWidth - left - pct(s.width) : 0;
    const ind = left || right ? `<w:ind w:left="${left}" w:right="${right}"/>` : '';
    return (
      `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${styleId(type)}">` +
      `<w:name w:val="${STYLE_NAME[type]}"/><w:basedOn w:val="Normal"/><w:next w:val="${type === 'character' ? 'Dialogue' : type === 'scene' ? 'Action' : styleId(type)}"/><w:qFormat/>` +
      `<w:pPr>${s.pPr ?? ''}<w:spacing w:before="${s.before}" w:after="0"/>${ind}</w:pPr>` +
      (s.rPr ? `<w:rPr>${s.rPr}</w:rPr>` : '') +
      `</w:style>`
    );
  });
  const eastAsia = format === 'korean' ? '바탕' : 'Batang';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Courier Prime" w:hAnsi="Courier Prime" w:eastAsia="${eastAsia}" w:cs="Courier New"/>` +
    `<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${format === 'korean' ? 'ko-KR' : 'en-US'}" w:eastAsia="ko-KR"/>` +
    `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${LINE}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="paragraph" w:customStyle="1" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:u w:val="single"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style>` +
    paragraphStyles.join('') +
    `</w:styles>`
  );
}

function body(project: DocxProject): string {
  const out: string[] = [];
  const p = (style: string, content: string, pPr = '') => out.push(`<w:p><w:pPr><w:pStyle w:val="${style}"/>${pPr}</w:pPr>${content}</w:p>`);

  // 표지 (인쇄용 원고와 같은 구성)
  p('Title', runs(project.title || '제목 없음'), `<w:spacing w:before="${Math.round(2.5 * TWIP)}"/>`);
  if (project.author) {
    p('Normal', runs(project.format === 'korean' ? '각본' : 'Written by'), `<w:jc w:val="center"/><w:spacing w:before="${Math.round(0.6 * TWIP)}"/>`);
    p('Normal', runs(project.author), '<w:jc w:val="center"/>');
  }
  if (project.contact) p('Normal', runs(project.contact), `<w:spacing w:before="${3 * TWIP}"/>`);

  let n = 0;
  project.elements.forEach((e, i) => {
    const pageBreak = i === 0 ? '<w:pageBreakBefore/>' : '';
    if (e.type !== 'scene') return p(styleId(e.type), runs(e.text), pageBreak);
    n++;
    if (project.format === 'korean') return p('SceneHeading', runs(`S#${n}. ${e.text}`), pageBreak);
    // 할리우드 서식: 장면 번호를 왼쪽 여백에 둔다.
    p('SceneHeading', runs(`${n}`, '<w:rPr><w:b w:val="0"/></w:rPr>') + '<w:r><w:tab/></w:r>' + runs(e.text), `${pageBreak}<w:ind w:left="0" w:hanging="${Math.round(0.75 * TWIP)}"/>`);
  });
  if (!project.elements.length) p('Action', '', '<w:pageBreakBefore/>');
  return out.join('');
}

function documentXml(project: DocxProject): string {
  const page = PAGE[project.format];
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body(project)}` +
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:headerReference w:type="first" r:id="rIdHeaderFirst"/>` +
    `<w:pgSz w:w="${page.w}" w:h="${page.h}"/>` +
    `<w:pgMar w:top="${MARGIN.top}" w:right="${MARGIN.right}" w:bottom="${MARGIN.bottom}" w:left="${MARGIN.left}" w:header="${Math.round(0.5 * TWIP)}" w:footer="${Math.round(0.5 * TWIP)}" w:gutter="0"/>` +
    // 표지를 0쪽으로 세어 본문 첫 쪽이 1쪽이 되게 한다.
    `<w:pgNumType w:start="0"/><w:titlePg/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

const HEADER_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const PAGE_HEADER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${HEADER_NS}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>` +
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
  `<w:r><w:t>.</w:t></w:r></w:p></w:hdr>`;
const EMPTY_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${HEADER_NS}><w:p/></w:hdr>`;

function coreXml(project: DocxProject): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(project.title)}</dc:title><dc:creator>${esc(project.author)}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
  `<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
  `<Relationship Id="rIdHeaderFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>` +
  `</Relationships>`;

export function docxParts(project: DocxProject): Record<string, string> {
  return {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'docProps/core.xml': coreXml(project),
    'word/document.xml': documentXml(project),
    'word/styles.xml': styles(project.format),
    'word/header1.xml': PAGE_HEADER,
    'word/header2.xml': EMPTY_HEADER,
    'word/_rels/document.xml.rels': DOCUMENT_RELS,
  };
}

export function toDocx(project: DocxProject): Uint8Array<ArrayBuffer> {
  return zip(docxParts(project));
}

// ---------------------------------------------------------------- zip (무압축 STORE)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 파일 이름
    h.setUint16(8, 0, true); // STORE
    h.setUint16(12, 0x21, true); // 1980-01-01
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    local.push(header, data);

    const entry = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += header.length + data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...local, ...central, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
