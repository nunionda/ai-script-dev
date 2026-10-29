import type { ElementType, Project, SceneMeta } from './types';
import { el } from './screenplay';
import type { ImportedScript } from './fountain';

const TYPE_TO_FDX: Record<ElementType, string> = {
  scene: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  transition: 'Transition',
  shot: 'Shot',
  general: 'General',
};

const FDX_TO_TYPE: Record<string, ElementType> = Object.fromEntries(
  Object.entries(TYPE_TO_FDX).map(([k, v]) => [v.toLowerCase(), k as ElementType]),
);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function para(type: string, text: string, inner = ''): string {
  return `    <Paragraph Type="${type}">${inner}\n      <Text>${esc(text)}</Text>\n    </Paragraph>`;
}

export function toFdx(project: Pick<Project, 'title' | 'author' | 'contact' | 'elements' | 'sceneMeta'>): string {
  const body: string[] = [];
  for (const e of project.elements) {
    const type = TYPE_TO_FDX[e.type];
    const parts = e.type === 'dialogue' ? [e.text] : e.text.split('\n');
    parts.forEach((part, i) => {
      let inner = '';
      const meta = e.type === 'scene' && i === 0 ? project.sceneMeta[e.id] : undefined;
      if (meta?.synopsis) {
        inner = `\n      <SceneProperties Title=""><Summary><Paragraph><Text>${esc(meta.synopsis)}</Text></Paragraph></Summary></SceneProperties>`;
      }
      body.push(para(type, part, inner));
    });
  }
  const titlePage = [
    project.title && `      <Paragraph Alignment="Center" Type="Title"><Text>${esc(project.title)}</Text></Paragraph>`,
    project.author && `      <Paragraph Alignment="Center" Type="Author"><Text>${esc(project.author)}</Text></Paragraph>`,
    project.contact && `      <Paragraph Alignment="Left" Type="Contact"><Text>${esc(project.contact)}</Text></Paragraph>`,
  ].filter(Boolean);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="5">',
    '  <Content>',
    ...body,
    '  </Content>',
    '  <TitlePage>',
    '    <Content>',
    ...titlePage,
    '    </Content>',
    '  </TitlePage>',
    '</FinalDraft>',
    '',
  ].join('\n');
}

function texts(inner: string): string {
  const out: string[] = [];
  const re = /<Text\b[^>]*?(?:\/>|>([\s\S]*?)<\/Text>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push(m[1] ?? '');
  return unesc(out.join(''));
}

export function fromFdx(xml: string): ImportedScript {
  const result: ImportedScript = { title: '', author: '', contact: '', elements: [], acts: [], sceneMeta: {} };

  const titleBlock = xml.match(/<TitlePage\b[\s\S]*?<\/TitlePage>/)?.[0] ?? '';
  const titleTexts = [...titleBlock.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)].map((m) => ({ attrs: m[1], text: texts(m[2]).trim() })).filter((p) => p.text);
  if (titleTexts.length) {
    result.title = titleTexts[0].text;
    const by = titleTexts.findIndex((p) => /^(written\s+)?by$|^각본$|^작가$/i.test(p.text));
    if (by >= 0 && titleTexts[by + 1]) result.author = titleTexts[by + 1].text;
    else if (titleTexts[1] && /Center/.test(titleTexts[1].attrs)) result.author = titleTexts[1].text;
  }

  let content = xml.replace(/<TitlePage\b[\s\S]*?<\/TitlePage>/g, '');
  const summaries: string[] = [];
  content = content.replace(/<SceneProperties\b[\s\S]*?(?:<\/SceneProperties>|\/>)/g, (block) => {
    const summary = block.match(/<Summary>([\s\S]*?)<\/Summary>/)?.[1];
    summaries.push(summary ? texts(summary).trim() : '');
    return `<!--SP${summaries.length - 1}-->`;
  });
  const main = content.match(/<Content>([\s\S]*?)<\/Content>/)?.[1] ?? content;

  for (const m of main.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
    const typeName = (m[1].match(/Type="([^"]*)"/)?.[1] ?? 'Action').toLowerCase();
    const type: ElementType = FDX_TO_TYPE[typeName] ?? (typeName === 'cast list' ? 'general' : 'action');
    const text = texts(m[2]);
    if (!text.trim()) continue;
    const e = el(type, text);
    result.elements.push(e);
    const sp = m[2].match(/<!--SP(\d+)-->/);
    if (sp && type === 'scene' && summaries[Number(sp[1])]) {
      const meta: SceneMeta = { synopsis: summaries[Number(sp[1])] };
      result.sceneMeta[e.id] = meta;
    }
  }
  return result;
}
