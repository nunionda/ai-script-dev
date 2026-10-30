import { z } from 'zod';
import type { ChatMessage, ChatSummary, Project, Proposal, ReferenceDocument, ReviewRole, RoleReview, ScriptElement, StructureAudit, TranslationLoss } from '../shared/types';
import { ELEMENT_TYPES } from '../shared/types';
import { el, getScenes } from '../shared/screenplay';
import { expandRuns } from '../shared/fountain';
import { AiError, currentSceneText, projectContext, requireScene, structured } from './ai';
import { AUTHORITY, CHECKLIST, CRAFT_PRINCIPLES, FORBIDDEN, RESEARCH_PROTOCOL, formatElements } from './prompts';

/*
 * 역할 검수자: 생성자와 평가자를 나눈다. 검수자는 같은 문서를 새로 읽고 판정만 한다 — 원고를 고치지 않는다.
 * 쓰기는 언제나 수정안 생성기(server/ai.ts generateProposal) 하나다.
 */

interface RoleDef {
  name: string;
  /** 이 역할이 판정하는 체크리스트 코드 */
  codes: string[];
  focus: string;
}

export const ROLES: Record<ReviewRole, RoleDef> = {
  STRUCT: {
    name: '구조',
    codes: ['C1', 'C3', 'C4', 'C5', 'C6', 'C7', 'C11'],
    focus: `하나의 행동과의 관계, 직전·직후 장면과의 인과('그래서/그러나'), 가치 전환과 수단, 셋업/회수 짝, 시퀀스 질문의 진전.
이 장면을 빼면 무엇이 무너지는지 한 문장으로 말할 수 없으면 삭제 후보로 보고한다.`,
  },
  CHAR: {
    name: '인물',
    codes: ['C1', 'C5', 'C12', 'C13'],
    focus: `욕망과 필요의 구분, 하마르티아(판단의 어긋남), 인물의 주체성 — 주인공이 피해자 서사의 객체가 되지 않는가.
시점 인물이 모르는 정보가 화면에 새지 않는가. 앞 장면들과 행동 논리가 이어지는가.`,
  },
  DIAL: {
    name: '대사',
    codes: ['C2', 'C9', 'C13', 'C17'],
    focus: `대사가 전술(설득·회피·시험·거래)로 작동하는가, 원하는 것을 직접 말하지 않는가, 주제어·설명 대사, 인물별 말투 일관성.
실존 작품 대사의 인용·재현이 없는가. 【확정】 대사가 그대로인가.`,
  },
  DIR: {
    name: '연출',
    codes: ['C8', 'C10', 'C14'],
    focus: `지문이 현재형·촬영 가능한 것만 쓰였는가, 감정 형용사 남용, 소리·이미지 모티프와 횟수 한도, 하드 규칙(V.O. 등).
톤 전환이 음악·형용사가 아니라 사건으로 일어나는가.`,
  },
  RES: {
    name: '고증',
    codes: ['C7', 'C16'],
    focus: `시대·직업·제도 고증(기기, 요금, 교통, 법·단속, 업계 관행, 은어). 사실 주장마다 [확인]/[추정]/[작가확인필요] 표지가 맞게 붙었는가.
참고 문서에 근거가 없는 디테일은 [추정]으로 판정하고, 확인할 항목을 suggestions에 적는다. 지어낸 출처를 쓰지 않는다.`,
  },
  ETH: {
    name: '윤리·수위',
    codes: ['C1', 'C9', 'C18'],
    focus: `재현 윤리: 대상화·관음적 시선·몸을 부분으로 자르는 지문·폭력의 미화가 없는가. 당사자 경험을 소비하지 않는가.
성적·폭력 장면은 노출·접촉·카메라 위치가 인티머시 라이더에 옮길 수 있을 만큼 구체적인가, 목표 등급 안인가.
당사자 컨설턴트에게 물어야 할 것은 consultantItems에 구체적인 질문으로 적는다.`,
  },
  STRAT: {
    name: '전략',
    codes: ['C3', 'C15'],
    focus: `로그라인·하나의 행동 대비 이 장면의 기여, 반클리셰 — 관객이 예상할 처리를 실제로 피했는가, 비슷한 작품과의 차별성.
영문 병행본·해외 영화제 관점에서 번역 손실이 큰 장치(말장난, 호칭, 사투리)가 있으면 짚는다.`,
  },
};

const checklistFor = (codes: string[]) =>
  CHECKLIST.filter(([c]) => codes.includes(c))
    .map(([c, t]) => `${c} ${t}`)
    .join('\n');

function reviewerInstructions(role: ReviewRole): string {
  const def = ROLES[role];
  return `<role>
너는 시나리오 개발 작업실 "FRAME"의 ${def.name} 검수자(${role})다. 수석 작가가 쓴 수정안을 독립적으로 읽고 판정한다.
너는 원고를 다시 쓰지 않는다. 판정과 근거, 고칠 방향만 낸다. 최종 결정은 작가가 한다.
</role>
${AUTHORITY}
${CRAFT_PRINCIPLES}
${RESEARCH_PROTOCOL}
${FORBIDDEN}
<focus>
${def.focus}
</focus>
<checklist note="이 항목들만 판정한다">
${checklistFor(def.codes)}
</checklist>
<rules>
- 수석 작가의 자기 검수를 믿지 말고 원문과 수정안을 직접 대조한다. 엄격하게 판정한다 — 애매하면 FAIL로 두고 이유를 쓴다.
- 근거는 판정·규칙 번호, 장면 번호, 원고 문장을 짧게 인용해서 댄다.
- risk: high=채택하면 판정서·확정 표현·윤리 문제가 생김, mid=고쳐야 할 결함, low=다듬을 거리.
- suggestions는 고칠 방향을 구체적인 행동·소품·대사 수준으로. 장면 전체를 다시 쓰지 않는다.
- 한국어로 간결하게.
</rules>`;
}

const ReviewSchema = z.object({
  verdicts: z.array(z.object({ code: z.string().describe('체크리스트 코드 (예: C4)'), pass: z.boolean(), note: z.string().describe('한 줄 근거') })),
  risk: z.enum(['high', 'mid', 'low']),
  summary: z.string().describe('판정 요약 1~2문장'),
  suggestions: z.array(z.string()).describe('고칠 방향'),
  consultantItems: z.array(z.string()).describe('당사자 컨설턴트에게 확인할 질문. 없으면 빈 배열'),
});

/** 수정안 하나를 한 역할이 검수한다. 수석 작가와 대화를 공유하지 않는 새 호출이다. */
export async function reviewProposal(
  project: Project,
  documents: ReferenceDocument[],
  proposal: Proposal,
  role: ReviewRole,
  signal?: AbortSignal,
): Promise<RoleReview> {
  const sc = requireScene(project, proposal.sceneId);
  const card = Object.entries(proposal.sceneCard)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const audit = proposal.audit.map((f) => `- ${f.code} (${f.level}) ${f.message}`).join('\n');
  const content = `${currentSceneText(sc, '현재 원고')}

<proposal title="${proposal.title}">
<instruction>${proposal.instruction || '(지시 없음)'}</instruction>
<scene_card>
${card || '(없음)'}
</scene_card>
<revised_scene>
${formatElements(proposal.revised, project)}
</revised_scene>
<rationale>${proposal.rationale}</rationale>
<code_audit note="코드가 판정한 결과 — 그대로 믿어도 된다">
${audit || '(걸린 항목 없음)'}
</code_audit>
</proposal>

<task>${ROLES[role].name} 검수자로서 위 수정안을 체크리스트 항목별로 판정하세요.</task>`;

  const parsed = await structured(ReviewSchema, [projectContext(project, documents), reviewerInstructions(role)], [{ role: 'user', content }], {
    maxTokens: 8000,
    effort: 'medium',
    refusal: '이 수정안을 검수할 수 없다는 응답을 받았습니다.',
    signal,
  });
  const codes = new Set(ROLES[role].codes);
  return {
    role,
    verdicts: parsed.verdicts.filter((v) => codes.has(v.code)),
    risk: parsed.risk,
    summary: parsed.summary.trim(),
    suggestions: parsed.suggestions.map((s) => s.trim()).filter(Boolean),
    consultantItems: parsed.consultantItems.map((s) => s.trim()).filter(Boolean),
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 전체 씬 로그 인과 감사

const StructureSchema = z.object({
  rows: z.array(
    z.object({
      label: z.string().describe('장면 번호만 (S#·헤딩 없이, 예: "12", "41-1")'),
      link: z.enum(['therefore', 'but', 'andthen']).describe('직전 장면과의 실제 연결'),
      valueShift: z.boolean().describe('가치가 실제로 바뀌는가'),
      onAction: z.boolean().describe('하나의 행동의 부분인가'),
      verdict: z.enum(['keep', 'revise', 'cut']),
      note: z.string().describe('판정 근거와 고칠 방향 한 문장'),
    }),
  ),
  summary: z.string().describe('전체 진단 2~3문장'),
  issues: z.array(z.string()).describe('시퀀스 질문·인과 사슬의 구조적 문제'),
});

const STRUCTURE_INSTRUCTIONS = `<role>
너는 시나리오 개발 작업실 "FRAME"의 구조 검수자(STRUCT)다. 원고 전체의 씬 로그를 인과 감사한다. 원고를 고치지 않는다.
</role>
${AUTHORITY}
${CRAFT_PRINCIPLES}
<rules>
- 삭제 장면을 뺀 모든 장면을 원고 순서대로 한 줄씩 판정한다. 장면 번호는 <scene_log>의 번호를 그대로 쓴다.
- link: 직전 장면과 '그래서'(결과)·'그러나'(역전)로 이어지는가, 단지 '그리고 나서'(시간 순서)인가. 작가가 적은 연결어가 아니라 실제 원고로 판정한다.
- valueShift: 장면 안에서 인물에게 걸린 가치가 바뀌는가. 정보만 전달하면 false.
- onAction: <one_action>의 부분인가. one_action이 비어 있으면 로그라인 기준으로 판정하고 summary에 그 사실을 밝힌다.
- verdict: keep / revise(연결어나 전환을 고치면 살아남음) / cut(빼도 전체가 흔들리지 않음).
- <audit_failures>는 코드가 판정한 결과다. 그대로 반영한다.
</rules>`;

export async function auditStructure(project: Project, documents: ReferenceDocument[], signal?: AbortSignal): Promise<StructureAudit> {
  const scenes = getScenes(project).filter((s) => !s.meta.omitted);
  if (!scenes.length) throw new AiError(400, '감사할 장면이 없습니다.');
  const parsed = await structured(
    StructureSchema,
    [projectContext(project, documents, { script: true }), STRUCTURE_INSTRUCTIONS],
    [{ role: 'user', content: '<task>원고 전체를 장면별로 인과 감사하세요.</task>' }],
    { maxTokens: 16000, effort: 'high', refusal: '구조 감사를 할 수 없다는 응답을 받았습니다.', signal },
  );
  const byLabel = new Map(scenes.map((s) => [s.label.toUpperCase(), s.id]));
  const rows = parsed.rows
    .map((r) => {
      // 모델이 "S#12. 내부. 방 - 밤"처럼 헤딩까지 붙여 쓰는 경우가 있다
      const label = r.label.trim().match(/^(?:S#\s*)?(\d+(?:-\d+|[A-Z]{1,2}\b)?)/i)?.[1]?.toUpperCase() ?? '';
      return { ...r, label, sceneId: byLabel.get(label) ?? '', note: r.note.trim() };
    })
    .filter((r) => r.sceneId);
  return { rows, summary: parsed.summary.trim(), issues: parsed.issues.map((s) => s.trim()).filter(Boolean), createdAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- 세션 요약

const SummarySchema = z.object({
  decisions: z
    .array(
      z.object({
        text: z.string().describe('판정서 문체의 한 문장'),
        quote: z.string().describe('작가가 그렇게 정했다는 근거 — <writer> 메시지에서 그대로 옮긴 구절 (AI 문장 금지)'),
      }),
    )
    .describe('작가가 자기 말로 분명히 정하거나 고른 것 — 판정서 후보'),
  open: z.array(z.string()).describe('논의했지만 작가가 정하지 않은 것 — 열린 질문'),
});

const SUMMARY_INSTRUCTIONS = `<role>너는 시나리오 작업실의 작가 보조다. AI 대화 세션을 정리한다.</role>
<rules>
- 결정은 작가만 한다. decisions에는 <writer> 메시지에서 작가가 자기 말로 정하거나 고른 것만 넣는다.
  예: "그걸로 하자", "B안으로 가", "세영은 끝까지 말하지 않는다" 같은 작가의 문장.
- AI(<assistant>)가 제안·추천·정리만 했고 작가가 그 뒤에 받아들인다고 말하지 않은 것은 decisions가 아니라 open에 넣는다.
- 질문("~할까?", "~는 어때?")은 결정이 아니다. open에 넣는다.
- 각 decision의 quote에는 작가의 <writer> 메시지에서 근거 구절을 글자 그대로 옮긴다. 옮길 문장이 없으면 그 항목은 decision이 아니다.
- 이미 판정서에 있는 내용은 다시 넣지 않는다.
- open에는 결론 없이 남은 쟁점, AI의 미채택 제안, 확인이 필요한 고증, 판정 요청(D-후보)을 넣는다.
- 각 항목은 대화를 안 본 사람도 이해할 수 있는 한 문장. 없으면 빈 배열.
</rules>`;

const squash = (s: string) => s.replace(/[\s"'“”‘’.,!?…~]/g, '');

/** 결정 후보의 근거 인용이 실제 작가 메시지에 있는지 코드로 확인한다. 없으면 미결 사항으로 내린다. */
export function checkDecisions(parsed: { decisions: { text: string; quote: string }[]; open: string[] }, writerMessages: string[]): ChatSummary {
  const writer = writerMessages.map(squash).join('\n');
  const decisions: string[] = [];
  const open = parsed.open.map((s) => s.trim()).filter(Boolean);
  for (const d of parsed.decisions) {
    const text = d.text.trim();
    if (!text) continue;
    const quote = squash(d.quote);
    if (quote.length >= 2 && writer.includes(quote)) decisions.push(text);
    else open.push(`(작가 확인 필요) ${text}`);
  }
  return { decisions, open };
}

export async function summarizeChat(project: Project, documents: ReferenceDocument[], history: ChatMessage[], signal?: AbortSignal): Promise<ChatSummary> {
  if (!history.length) throw new AiError(400, '정리할 대화가 없습니다.');
  const transcript = history.map((m) => `<${m.role === 'user' ? 'writer' : 'assistant'}>\n${m.content}\n</${m.role === 'user' ? 'writer' : 'assistant'}>`).join('\n');
  const parsed = await structured(
    SummarySchema,
    [projectContext(project, documents), SUMMARY_INSTRUCTIONS],
    [{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>\n\n<task>이 대화를 결정 후보와 미결 사항으로 정리하세요.</task>` }],
    { maxTokens: 4000, effort: 'low', refusal: '대화를 정리할 수 없다는 응답을 받았습니다.', signal },
  );
  return checkDecisions(
    parsed,
    history.filter((m) => m.role === 'user').map((m) => m.content),
  );
}

// ---------------------------------------------------------------- 영문 병행본

const TranslationSchema = z.object({
  elements: z
    .array(z.object({ type: z.enum(ELEMENT_TYPES), text: z.string() }))
    .describe('번역한 장면 전체. 첫 요소는 씬 헤딩'),
  losses: z
    .array(
      z.object({
        original: z.string().describe('원문 구절'),
        translation: z.string().describe('번역문'),
        loss: z.string().describe('잃은 것 (존댓말·반말, 호칭, 사투리, 말장난, 문화 맥락 …)'),
        compensation: z.string().describe('보완한 방법. 못 했으면 "없음"'),
      }),
    )
    .describe('번역 손실표'),
  names: z.array(z.object({ ko: z.string(), en: z.string() })).describe('이 장면에 쓴 인물·장소 이름 표기'),
});

const TRANSLATION_INSTRUCTIONS = `<role>
너는 시나리오 개발 작업실 "FRAME"의 전략 검수자(STRAT)이자 영문 병행본 번역가다. 한국어 정본의 장면을 영어 시나리오로 옮긴다.
정본이 언제나 우선이다. 번역은 정본을 바꾸지 않고, 장면의 사건·순서·비트를 더하거나 빼지 않는다.
</role>
${AUTHORITY}
<rules>
- 할리우드식 마스터 씬 서식. 씬 헤딩은 "INT./EXT. LOCATION - DAY/NIGHT" (대문자), 장면 번호는 붙이지 않는다.
- 인물 이름은 <names>의 표기를 그대로 쓴다. 처음 나오는 이름은 표준 로마자 표기로 정하고 names에 적는다. character 요소는 대문자 이름만.
- 정본에서 원래 영어로 말한 대사는 문장을 그대로 두고 바로 앞에 parenthetical "(in English)"를 넣는다.
- 하위텍스트를 보존한다. 직역보다 같은 전술(설득·회피·시험·거래)이 작동하는 영어 대사를 쓴다. 설명을 덧붙이지 않는다.
- 【확정】 요소는 의미와 리듬을 가장 충실히 옮기고, 무엇을 잃었는지 losses에 반드시 적는다.
- 존댓말·반말 전환, 호칭(언니·형·선배), 사투리, 말장난, 한국어 고유 맥락은 losses에 원문·번역·잃은 것·보완 방법으로 적는다.
- 지문은 현재형, 촬영 가능한 것만. 원문 지문의 정보량을 지킨다.
- 【확정】, 〈극중극〉, {태그} 표시 자체는 출력하지 않는다.
- elements에는 시나리오 요소를 하나씩 넣는다 (헤딩, 지문 한 문단, 인물 이름, 괄호 지시, 대사가 각각 한 요소). 한 요소에 장면 전체를 몰아 쓰지 않는다.
</rules>`;

export interface SceneTranslation {
  elements: ScriptElement[];
  losses: TranslationLoss[];
  names: Record<string, string>;
}

export async function translateScene(
  source: Project,
  documents: ReferenceDocument[],
  sourceSceneId: string,
  names: Record<string, string>,
  signal?: AbortSignal,
): Promise<SceneTranslation> {
  const sc = requireScene(source, sourceSceneId);
  if (source.sceneMeta[sourceSceneId]?.omitted) throw new AiError(400, '정본에서 삭제한 장면은 번역하지 않습니다.');
  const glossary = Object.entries(names)
    .map(([ko, en]) => `${ko} → ${en}`)
    .join('\n');
  const parsed = await structured(
    TranslationSchema,
    [projectContext(source, documents), TRANSLATION_INSTRUCTIONS],
    [
      {
        role: 'user',
        content: `<names note="이미 정한 이름 표기">\n${glossary || '(아직 없음)'}\n</names>\n\n${currentSceneText(sc, '번역할 장면')}\n\n<task>이 장면을 영어 시나리오로 옮기고 번역 손실표를 작성하세요.</task>`,
      },
    ],
    { maxTokens: 16000, effort: 'medium', refusal: '이 장면을 번역할 수 없다는 응답을 받았습니다.', signal },
  );
  const elements = expandRuns(parsed.elements)
    .filter((e) => e.text.trim())
    .map((e) => el(e.type, e.type === 'scene' ? e.text.trim().replace(/^(S#\s*)?[\w-]+\.\s+(?=(INT|EXT|I\/E))/i, '') : e.text.trim()));
  if (!elements.length) throw new AiError(502, '번역 결과가 비어 있습니다. 다시 시도해 주세요.');
  if (elements[0].type !== 'scene') elements.unshift(el('scene', 'INT. UNKNOWN - DAY'));
  const learned: Record<string, string> = {};
  for (const n of parsed.names) if (n.ko.trim() && n.en.trim()) learned[n.ko.trim()] = n.en.trim();
  return { elements, losses: parsed.losses, names: learned };
}
