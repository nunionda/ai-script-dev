import type { ElementType, Project } from './types';
import { printableElements, sceneLabels } from './screenplay';
import { zip } from './docx';

// 한글(.hwpx, OWPML) 내보내기. Word 내보내기(docx.ts)와 같은 여백·들여쓰기·표지를 쓰고,
// 요소마다 같은 이름의 문단 스타일을 만들어 한글에서도 스타일로 서식을 고칠 수 있게 한다.

type HwpxProject = Pick<Project, 'title' | 'author' | 'contact' | 'elements' | 'format'> & Partial<Pick<Project, 'sceneMeta' | 'numberingLocked'>>;

const INCH = 7200; // HWPUNIT
const PAGE = {
  korean: { w: 59528, h: 84186 }, // A4
  hollywood: { w: 61200, h: 79200 }, // US Letter
};
const MARGIN = { top: INCH, bottom: Math.round(0.8 * INCH), left: Math.round(1.5 * INCH), right: INCH, header: Math.round(0.5 * INCH), footer: Math.round(0.5 * INCH) };
const LINE = 1200; // 12pt

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" ' +
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ' +
  'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ' +
  'xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'] as const;

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 문단 스타일: 0은 한글 기본 "바탕글", 그 뒤로 표지·요소 종류별 */
const STYLES: { key: 'normal' | 'title' | 'center' | ElementType; name: string; eng: string }[] = [
  { key: 'normal', name: '바탕글', eng: 'Normal' },
  { key: 'title', name: '제목', eng: 'Title' },
  { key: 'center', name: '가운데', eng: 'Center' },
  { key: 'scene', name: '씬 헤딩', eng: 'Scene Heading' },
  { key: 'action', name: '지문', eng: 'Action' },
  { key: 'character', name: '인물', eng: 'Character' },
  { key: 'parenthetical', name: '괄호 지시', eng: 'Parenthetical' },
  { key: 'dialogue', name: '대사', eng: 'Dialogue' },
  { key: 'transition', name: '전환', eng: 'Transition' },
  { key: 'shot', name: '샷', eng: 'Shot' },
  { key: 'general', name: '일반', eng: 'General' },
];
const styleIndex = (key: (typeof STYLES)[number]['key']) => STYLES.findIndex((s) => s.key === key);

/** 글자 모양: 0 보통, 1 굵게, 2 표지 제목 */
const CHAR = { normal: 0, bold: 1, title: 2 } as const;

function header(format: HwpxProject['format']): string {
  const hangulFont = '함초롬바탕';
  const latinFont = format === 'hollywood' ? 'Courier New' : '함초롬바탕';
  const fontfaces = LANGS.map(
    (lang) =>
      `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="${lang === 'LATIN' ? latinFont : hangulFont}" type="TTF" isEmbedded="0">` +
      `<hh:typeInfo familyType="FCAT_MYUNGJO" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font></hh:fontface>`,
  ).join('');
  const all = (v: number | string) => LANGS.map((l) => `${l.toLowerCase()}="${v}"`).join(' ');
  const size = format === 'hollywood' ? 1200 : 1100;
  const charPr = (id: number, height: number, extra = '') =>
    `<hh:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">` +
    `<hh:fontRef ${all(0)}/><hh:ratio ${all(100)}/><hh:spacing ${all(0)}/><hh:relSz ${all(100)}/><hh:offset ${all(0)}/>${extra}</hh:charPr>`;

  const textWidth = PAGE[format].w - MARGIN.left - MARGIN.right;
  const pct = (n: number) => Math.round((textWidth * n) / 100);
  // docx.ts와 같은 비율: 왼쪽 들여쓰기 %, 폭 %
  const spec: Record<(typeof STYLES)[number]['key'], { left?: number; width?: number; before: number; align?: string; keep?: boolean }> = {
    normal: { before: 0 },
    title: { before: 0, align: 'CENTER' },
    center: { before: 0, align: 'CENTER' },
    scene: { before: 2 * LINE, keep: true },
    action: { before: LINE },
    character: { left: 37, before: LINE, keep: true },
    parenthetical: { left: 27, width: 40, before: 0, keep: true },
    dialogue: { left: 17, width: 58, before: 0 },
    transition: { before: LINE, align: 'RIGHT' },
    shot: { before: LINE },
    general: { before: LINE },
  };
  const lineSpacing = format === 'hollywood' ? 120 : 130;
  const paraPrs = STYLES.map((s, id) => {
    const p = spec[s.key];
    const left = p.left ? pct(p.left) : 0;
    const right = p.width ? textWidth - left - pct(p.width) : 0;
    return (
      `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0">` +
      `<hh:align horizontal="${p.align ?? (format === 'korean' && (s.key === 'action' || s.key === 'dialogue') ? 'JUSTIFY' : 'LEFT')}" vertical="BASELINE"/>` +
      `<hh:heading type="NONE" idRef="0" level="0"/>` +
      `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${p.keep ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
      `<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>` +
      // 한글은 문단 여백·간격을 실제 값의 2배로 저장한다 (한글에서 1인치로 맞춘 왼쪽 여백이 14400으로 저장됨)
      `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="${left * 2}" unit="HWPUNIT"/><hc:right value="${right * 2}" unit="HWPUNIT"/>` +
      `<hc:prev value="${p.before * 2}" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin>` +
      `<hh:lineSpacing type="PERCENT" value="${lineSpacing}" unit="HWPUNIT"/>` +
      `<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
    );
  }).join('');
  const charFor = (key: (typeof STYLES)[number]['key']) => (key === 'title' ? CHAR.title : key === 'scene' || key === 'character' ? CHAR.bold : CHAR.normal);
  const styles = STYLES.map(
    (s, id) =>
      `<hh:style id="${id}" type="PARA" name="${s.name}" engName="${s.eng}" paraPrIDRef="${id}" charPrIDRef="${charFor(s.key)}" ` +
      `nextStyleIDRef="${s.key === 'character' ? styleIndex('dialogue') : s.key === 'scene' ? styleIndex('action') : id}" langID="1042" lockForm="0"/>`,
  ).join('');
  const border = (id: number, fill = '') =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
    `<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>` +
    `<hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill}</hh:borderFill>`;

  return (
    `${XML}<hh:head ${NS} version="1.2" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
    `<hh:fontfaces itemCnt="${LANGS.length}">${fontfaces}</hh:fontfaces>` +
    `<hh:borderFills itemCnt="2">${border(1)}${border(2, '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush>')}</hh:borderFills>` +
    `<hh:charProperties itemCnt="3">${charPr(0, size)}${charPr(1, size, '<hh:bold/>')}${charPr(2, 2000, '<hh:bold/>')}</hh:charProperties>` +
    `<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>` +
    `<hh:paraProperties itemCnt="${STYLES.length}">${paraPrs}</hh:paraProperties>` +
    `<hh:styles itemCnt="${STYLES.length}">${styles}</hh:styles>` +
    `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>` +
    `<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`
  );
}

function secPr(format: HwpxProject['format']): string {
  const page = PAGE[format];
  const noteShape = (place: string) =>
    `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>` +
    `<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/>`;
  const pageBorder = (type: string) =>
    `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return (
    `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    // 표지에는 쪽 번호를 숨긴다
    `<hp:visibility hideFirstHeader="1" hideFirstFooter="1" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="1" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="${page.w}" height="${page.h}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${MARGIN.header}" footer="${MARGIN.footer}" gutter="0" left="${MARGIN.left}" right="${MARGIN.right}" top="${MARGIN.top}" bottom="${MARGIN.bottom}"/></hp:pagePr>` +
    `<hp:footNotePr>${noteShape('EACH_COLUMN')}</hp:footNotePr><hp:endNotePr>${noteShape('END_OF_DOCUMENT')}</hp:endNotePr>` +
    `${pageBorder('BOTH')}${pageBorder('EVEN')}${pageBorder('ODD')}</hp:secPr>` +
    `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>` +
    // 쪽 번호: 오른쪽 위
    `<hp:ctrl><hp:pageNum pos="TOP_RIGHT" formatType="DIGIT" sideChar=""/></hp:ctrl>`
  );
}

function textXml(text: string): string {
  return text
    .split('\n')
    .map((line) => line.split('\t').map(esc).join('<hp:tab/>'))
    .join('<hp:lineBreak/>');
}

function section(project: HwpxProject): string {
  const paras: string[] = [];
  let id = 0;
  const p = (style: (typeof STYLES)[number]['key'], text: string, opts: { pageBreak?: boolean; char?: number; lead?: string } = {}) => {
    const sid = styleIndex(style);
    const char = opts.char ?? (style === 'title' ? CHAR.title : style === 'scene' || style === 'character' ? CHAR.bold : CHAR.normal);
    paras.push(
      `<hp:p id="${id++}" paraPrIDRef="${sid}" styleIDRef="${sid}" pageBreak="${opts.pageBreak ? 1 : 0}" columnBreak="0" merged="0">` +
        (opts.lead ? `<hp:run charPrIDRef="${char}">${opts.lead}</hp:run>` : '') +
        `<hp:run charPrIDRef="${char}"><hp:t>${textXml(text)}</hp:t></hp:run></hp:p>`,
    );
  };

  // 표지 (인쇄용 원고와 같은 구성). 첫 문단에 구역 설정을 넣는다.
  const blank = (n: number) => {
    for (let i = 0; i < n; i++) p('center', '');
  };
  p('center', '', { lead: secPr(project.format) });
  blank(8);
  p('title', project.title || '제목 없음');
  if (project.author) {
    blank(2);
    p('center', project.format === 'korean' ? '각본' : 'Written by');
    p('center', project.author);
  }
  if (project.contact) {
    blank(10);
    p('normal', project.contact);
  }

  const source = { ...project, acts: [], sceneMeta: project.sceneMeta ?? {} };
  const labels = sceneLabels(source);
  const elements = printableElements(source);
  elements.forEach((e, i) => {
    const pageBreak = i === 0;
    if (e.type !== 'scene') return p(e.type, e.text, { pageBreak });
    const n = labels.get(e.id);
    p('scene', project.format === 'korean' ? `S#${n}. ${e.text}` : `${n}\t${e.text}`, { pageBreak });
  });
  if (!elements.length) p('action', '', { pageBreak: true });
  return `${XML}<hs:sec ${NS}>${paras.join('')}</hs:sec>`;
}

function contentHpf(project: HwpxProject): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return (
    `${XML}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(project.title)}</opf:title><opf:language>ko</opf:language>` +
    `<opf:meta name="creator" content="text">${esc(project.author)}</opf:meta><opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta></opf:metadata>` +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>` +
    `<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>` +
    `<opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/></opf:spine></opf:package>`
  );
}

export function hwpxParts(project: HwpxProject): Record<string, string> {
  // mimetype이 zip의 첫 항목(무압축)이어야 한다
  return {
    mimetype: 'application/hwp+zip',
    'version.xml':
      `${XML}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.2" application="Hancom Office Hangul" appVersion="11, 0, 0, 0"/>`,
    'Contents/header.xml': header(project.format),
    'Contents/section0.xml': section(project),
    'Contents/content.hpf': contentHpf(project),
    'settings.xml': `${XML}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
    'META-INF/container.xml':
      `${XML}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>` +
      `<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
    'META-INF/manifest.xml': `${XML}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
  };
}

export function toHwpx(project: HwpxProject): Uint8Array<ArrayBuffer> {
  return zip(hwpxParts(project));
}
