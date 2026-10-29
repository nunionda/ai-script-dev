import type { ElementType, ScriptFormat } from './types';
import { HEADING_PREFIXES, TIMES, TRANSITIONS } from './screenplay';

export interface SuggestContext {
  characters: string[];
  locations: string[];
  format: ScriptFormat;
}

const PREFIX_RE = /^(INT\.\/EXT\.|INT\.|EXT\.|EST\.|I\/E\.|내부\/외부\.|내부\.|외부\.)\s*/i;
const SEP = ' - ';
const MAX = 8;

const starts = (candidate: string, typed: string) => candidate.toLowerCase().startsWith(typed.toLowerCase()) && candidate.toLowerCase() !== typed.toLowerCase();

/**
 * Final Draft의 SmartType처럼 현재 요소 텍스트를 완성할 후보를 돌려준다.
 * 후보는 요소 전체를 대체할 텍스트다.
 */
export function suggest(type: ElementType, text: string, ctx: SuggestContext): string[] {
  if (text.includes('\n')) return [];
  if (type === 'character') {
    if (!text.trim()) return [];
    return ctx.characters.filter((c) => starts(c, text.trim())).slice(0, MAX);
  }
  if (type === 'transition') {
    return TRANSITIONS.filter((t) => !text || starts(t, text)).slice(0, MAX);
  }
  if (type !== 'scene') return [];

  const prefixes = [...HEADING_PREFIXES[ctx.format], ...HEADING_PREFIXES[ctx.format === 'korean' ? 'hollywood' : 'korean']];
  const m = text.match(PREFIX_RE);
  if (!m) {
    return prefixes.filter((p) => !text || starts(p, text)).slice(0, MAX);
  }
  const prefix = text.slice(0, m[0].length);
  const rest = text.slice(m[0].length);
  const sepAt = rest.lastIndexOf(SEP);
  if (sepAt < 0) {
    if (rest.endsWith(' -')) return [];
    const locs = ctx.locations.filter((l) => (!rest ? true : starts(l, rest)));
    return locs.slice(0, MAX).map((l) => `${prefix.trimEnd()} ${l}`);
  }
  const before = rest.slice(0, sepAt);
  const time = rest.slice(sepAt + SEP.length);
  const timeList = /[가-힣]/.test(before) || ctx.format === 'korean' ? [...TIMES.korean, ...TIMES.hollywood] : [...TIMES.hollywood, ...TIMES.korean];
  return timeList
    .filter((t) => !time || starts(t, time))
    .slice(0, MAX)
    .map((t) => `${prefix.trimEnd()} ${before}${SEP}${t}`);
}
