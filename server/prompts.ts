import type { Project, ReferenceDocument, ScriptElement } from '../shared/types';
import { ELEMENT_INFO, getScenes, sceneElements, sceneLabels } from '../shared/screenplay';
import { STAGE_LABEL, auditProject, counterStatus, motifLedger } from '../shared/audit';

/*
 * 프롬프트 구성 (Anthropic 권고): 긴 문서는 맨 위, 지시는 그 뒤, 작업은 마지막 user 메시지.
 * 작품마다 다른 것(판정서·바이블·규칙·태그)은 모두 Project 데이터에서 온다. 여기의 상수는 작품과 무관하다.
 */

const DOC_KIND_LABEL: Record<ReferenceDocument['kind'], string> = {
  synopsis: '시놉시스',
  treatment: '트리트먼트',
  'scene-log': '씬 로그',
  characters: '인물 설정서',
  'scene-bank': '장면 은행',
  research: '취재 노트',
  other: '참고 문서',
};

export const LINK_LABEL = { therefore: '그래서', but: '그러나', andthen: '그리고 나서' } as const;
export const TURN_LABEL = { action: '행동', revelation: '폭로' } as const;

/** 원고 요소를 모델이 읽는 형태로. 【확정】·〈극중극〉·태그 표시를 함께 붙인다. */
export function formatElements(elements: ScriptElement[], p: Pick<Project, 'elementMarks' | 'tagCategories'>, labels?: Map<string, string>): string {
  const catName = new Map(p.tagCategories.map((c) => [c.id, c.name]));
  return elements
    .map((e) => {
      const mark = p.elementMarks[e.id];
      const notes = [
        mark?.locked ? '【확정】' : '',
        mark?.play ? '〈극중극〉' : '',
        ...(mark?.tags ?? []).map((t) => `{${catName.get(t.cat) ?? t.cat}${t.stage ? ` — ${STAGE_LABEL[t.stage]}` : ''}}`),
      ].filter(Boolean);
      const suffix = notes.length ? `  ${notes.join(' ')}` : '';
      if (e.type === 'scene') {
        const n = labels?.get(e.id);
        return `\n[씬 헤딩] ${n ? `S#${n}. ` : ''}${e.text}${suffix}`;
      }
      return `[${ELEMENT_INFO[e.type].label}] ${e.text.replace(/\n/g, '\n    ')}${suffix}`;
    })
    .join('\n')
    .trim();
}

function doc(index: number, source: string, content: string, priority?: string): string {
  return `<document index="${index}"${priority ? ` priority="${priority}"` : ''}>\n<source>${source}</source>\n<document_content>\n${content.trim() || '(비어 있음)'}\n</document_content>\n</document>`;
}

/** <documents>: 판정서 전문이 언제나 첫 번째. 그다음 참고 문서, 요청 시 원고 전체. */
export function documentsBlock(p: Project, documents: ReferenceDocument[], opts: { script?: boolean } = {}): string {
  const parts: string[] = [];
  const rulings = p.rulings.filter((r) => r.text.trim());
  parts.push(doc(1, '판정서', rulings.length ? rulings.map((r) => `${r.code}. ${r.text.trim()}`).join('\n') : '(아직 판정서가 없습니다)', '최우선'));
  for (const d of documents) parts.push(doc(parts.length + 1, `${DOC_KIND_LABEL[d.kind]} — ${d.title}`, d.content));
  if (opts.script) parts.push(doc(parts.length + 1, '원고 전체', formatElements(p.elements, p, sceneLabels(p))));
  return `<documents>\n${parts.join('\n')}\n</documents>`;
}

/** <project_bible>: 작품의 규칙과, 코드가 센 장부·횟수 현황 */
export function bibleBlock(p: Project): string {
  const lines: string[] = [];
  const scenes = getScenes(p);
  const label = new Map(scenes.map((s) => [s.id, s.label]));
  const where = (id: string | null) => (id ? `S#${label.get(id)}` : '첫 장면 앞');

  lines.push(`<title>${p.title}</title>`);
  if (p.genre) lines.push(`<genre>${p.genre}</genre>`);
  if (p.logline) lines.push(`<logline>${p.logline}</logline>`);
  lines.push(`<format>${p.format === 'korean' ? '한국식 (S#번호. 장소 - 시간)' : '할리우드식 마스터 씬 (INT./EXT. LOCATION - TIME)'}</format>`);
  lines.push(`<one_action>${p.oneAction.trim() || '(아직 정하지 않음 — 정해지기 전에는 구조 판단을 단정하지 말 것)'}</one_action>`);

  const rules = p.hardRules.filter((r) => r.text.trim());
  if (rules.length) lines.push(`<hard_rules>\n${rules.map((r) => `${r.code}. ${r.text.trim()}`).join('\n')}\n</hard_rules>`);
  if (p.auditOptions.banVoiceOver) lines.push('<rule>V.O.·내레이션을 쓰지 않는다.</rule>');
  if (p.bannedWords.length) lines.push(`<banned_words note="인물이 대사로 말하지 않는다. 〈극중극〉 표시 요소만 예외">${p.bannedWords.join(', ')}</banned_words>`);

  const chars = Object.entries(p.characters).filter(([, c]) => c.description.trim());
  if (chars.length) lines.push(`<characters>\n${chars.map(([n, c]) => `- ${n}: ${c.description.trim()}`).join('\n')}\n</characters>`);

  if (p.tagCategories.length) {
    const ledger = motifLedger(p)
      .map((row) => {
        const hits = row.hits.map((h) => `${where(h.sceneId)}${h.tag.stage ? ` ${STAGE_LABEL[h.tag.stage]}` : ''}`).join(', ');
        return `- ${row.category.name}: ${hits || '아직 없음'}`;
      })
      .join('\n');
    if (ledger) lines.push(`<motif_ledger note="등록된 모티프만 쓴다. 새 상징 모티프를 만들지 않는다. 셋업 없는 회수·회수 없는 셋업 금지">\n${ledger}\n</motif_ledger>`);
    const counters = counterStatus(p)
      .map((c) => `- ${c.category.name}: 현재 ${c.count}회 / ${c.category.exact !== undefined ? `정확히 ${c.category.exact}회` : `최대 ${c.category.max}회`}`)
      .join('\n');
    if (counters) lines.push(`<counters note="작품 전체 누적. 한도를 넘기지 않는다">\n${counters}\n</counters>`);
  }

  const locked = p.elements.filter((e) => p.elementMarks[e.id]?.locked);
  if (locked.length) {
    let sceneId: string | null = null;
    const loc = new Map<string, string | null>();
    for (const e of p.elements) {
      if (e.type === 'scene') sceneId = e.id;
      loc.set(e.id, sceneId);
    }
    lines.push(`<locked_expressions note="작가 확정 표현. 한 글자도 바꾸지 않는다">\n${locked.map((e) => `- ${where(loc.get(e.id) ?? null)} [${ELEMENT_INFO[e.type].label}] ${e.text}`).join('\n')}\n</locked_expressions>`);
  }

  if (p.openQuestions.length) lines.push(`<open_questions>\n${p.openQuestions.map((q) => `- ${q}`).join('\n')}\n</open_questions>`);

  const actTitle = new Map(p.acts.map((a) => [a.id, a.title]));
  const log = scenes.map((s) => {
    const m = s.meta;
    if (m.omitted) return `- S#${s.label}. 삭제`;
    const card = [
      m.synopsis && `요약: ${m.synopsis}`,
      m.intent && `의도: ${m.intent}`,
      m.pov && `시점: ${m.pov}`,
      m.link && `연결: ${LINK_LABEL[m.link]}`,
      (m.valueStart || m.valueEnd) && `가치: ${m.valueStart || '?'} → ${m.valueEnd || '?'}${m.turnBy ? ` (${TURN_LABEL[m.turnBy]})` : ''}`,
    ].filter(Boolean);
    return `- S#${s.label}. ${s.heading} [${actTitle.get(s.actId) ?? ''}]${card.length ? ` — ${card.join(' / ')}` : ''}`;
  });
  lines.push(`<scene_log>\n${log.join('\n')}\n</scene_log>`);

  const findings = auditProject(p).filter((f) => f.level === 'fail');
  if (findings.length) lines.push(`<audit_failures note="코드가 판정한 현재 위반">\n${findings.map((f) => `- ${f.code} ${f.message}`).join('\n')}\n</audit_failures>`);

  return `<project_bible>\n${lines.join('\n')}\n</project_bible>`;
}

/** 장면 하나를 원고 표기대로 */
export function sceneBlock(p: Project, sceneId: string): { label: string; text: string; card: string } | null {
  const s = getScenes(p).find((x) => x.id === sceneId);
  if (!s) return null;
  const m = s.meta;
  const card = [
    m.pov && `시점 인물: ${m.pov}`,
    m.goal && `목표: ${m.goal}`,
    m.obstacle && `장애: ${m.obstacle}`,
    m.outcome && `결과: ${m.outcome}`,
    (m.valueStart || m.valueEnd) && `가치: ${m.valueStart || '?'} → ${m.valueEnd || '?'}`,
    m.turnBy && `전환 수단: ${TURN_LABEL[m.turnBy]}`,
    m.link && `직전 장면과의 연결: ${LINK_LABEL[m.link]}`,
    m.intent && `의도: ${m.intent}`,
    m.ratingNote && `수위·재현 메모: ${m.ratingNote}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { label: s.label, text: formatElements(sceneElements(p.elements, sceneId), p, sceneLabels(p)), card };
}

export const CRAFT_PRINCIPLES = `<craft_principles>
P1. 하나의 행동: 모든 장면은 <one_action>의 부분이어야 한다. 빼도 전체가 흔들리지 않는 장면은 삭제 후보로 보고한다.
P2. 장면은 사건이다: 각 장면은 인물의 삶에 걸린 가치를 +→− 또는 −→+로 바꾼다. 전환 수단은 행동 또는 폭로뿐이다.
P3. 목표·장애·결과: 누가 무엇을 원하는가 / 무엇이 막는가 / 어떻게 끝나는가(대개 예상과 다르게)를 먼저 정한다.
P4. 인과 사슬: 직전 장면과의 연결어는 '그래서' 또는 '그러나'. '그리고 나서'는 실패다.
P5. 급전과 발견: 큰 전환은 개연성에서 나오고, 가장 강한 발견은 급전과 겹친다. 발견은 정보 전달이 아니라 인물의 위치를 바꾸는 사건이다.
P6. 인물: 욕망(외적 목표)과 필요(심리적+도덕적)를 구분한다. 인물은 처음에 자기 필요를 모른다. 하마르티아는 '판단의 어긋남'으로 설계한다. 주인공을 피해자 서사의 객체로 두지 않는다.
P7. 하위텍스트: 인물은 원하는 것을 직접 말하지 않는다. 대사는 전술(설득·회피·시험·거래)이다. 감정은 형용사가 아니라 행동과 선택으로 보인다.
P8. 셋업과 페이오프: 회수할 것만 심고, 심은 것은 회수한다.
P9. 구조: 부·막마다 시퀀스 질문을 정하고, 시퀀스는 부분적으로만 해결된 채 다음 시퀀스를 만든다. 8시퀀스는 진단 도구이지 틀이 아니다.
P10. 톤: 톤 전환은 사건(행동)이 일으킨다. 음악·지문 형용사로 만들지 않는다.
P11. 반클리셰: 이 순간 관객이 예상할 가장 흔한 처리 3가지를 적고 그 셋을 피한다. 낯섦을 위해 개연성을 희생하지 않는다.
P12. 구체성: 취재 노트의 디테일(노동의 절차, 시간, 돈, 도구, 은어)을 우선 쓴다.
</craft_principles>`;

export const AUTHORITY = `<authority_order>
충돌 시 우선순위 (위가 이긴다):
1. 판정서(<documents>의 첫 문서, R·D 번호) — 어떤 이유로도 어기지 않는다.
2. 작가 확정 표현 — 【확정】 표시 요소와 <locked_expressions>. 한 글자도 바꾸지 않는다.
3. <project_bible>의 하드 규칙·금지어·모티프·횟수 한도
4. 현재 작업 지시
5. <craft_principles>와 너의 판단
지시가 상위 규칙과 충돌하면 그 부분을 쓰지 말고 충돌을 보고한다. 판정서에 없는 새 쟁점은 'D-후보'(판정 요청)로 올리고, 스스로 판정을 만들지 않는다.
</authority_order>`;

export const RESEARCH_PROTOCOL = `<research_protocol>
- 사실 주장에는 표지를 단다: [확인: 문서 이름 또는 출처] / [추정: 근거] / [작가확인필요].
- 시대 고증(기기, 요금, 교통, 법·단속, 업계 관행, 은어)은 참고 문서에 없으면 [추정]으로만 쓴다.
- 모르면 모른다고 쓴다. 그럴듯한 고유명사·통계·법조문을 지어내지 않는다.
</research_protocol>`;

export const FORBIDDEN = `<forbidden>
- 판정서 해석을 바꾸거나 새 판정을 스스로 만드는 것
- 확정 표현 다듬기 (맞춤법 포함, 작가 확인 전 일체)
- 실존 작가·감독 사칭, 실존 작품 대사 인용·재현
- 인물이 주제를 설명하는 대사, 깨달음을 말로 요약하는 결말
- 편리한 우연(마침 그때, 우연히 들은 대화)으로 문제를 푸는 것
- 몸을 부분으로 자르는 지문, 관음적 시선의 지문, 폭력을 아름답게 만드는 연출 지시
- 요청받지 않은 전면 재작성
</forbidden>`;

const ROLE = `<role>
너는 시나리오 개발 작업실 "FRAME"의 수석 작가 겸 쇼러너 에이전트다. 너의 일은 작가의 결정을 정확히 집행하고, 모든 산출물이 판정서·바이블·작법 원칙을 통과하게 하는 것이다.
너는 결정권자가 아니다. 최종 결정은 언제나 작가가 한다. 선택지를 근거와 함께 제시하고, 작가가 고르면 그대로 따른다.
논쟁보다 고쳐 쓴 버전으로 제안하고, 구조를 뒤집는 결정은 작가에게 맡긴다.
</role>`;

/** 채팅용 지시 */
export const PARTNER_INSTRUCTIONS = `${ROLE}
${AUTHORITY}
${CRAFT_PRINCIPLES}
${RESEARCH_PROTOCOL}
${FORBIDDEN}
<answer_style>
- 문서 근거가 필요한 판단은 먼저 관련 판정·규칙 번호를 짧게 인용한다 (예: "R3: …").
- 일반론보다 지금 장면의 구체적인 행동, 소품, 대사로 이야기한다. 예시 대사·지문은 인용 블록(>)으로.
- 판정서와 충돌하는 요청이면 쓰지 말고 충돌한 번호와 이유를 말한 뒤 작가의 판정을 묻는다.
- 판정이 필요한 새 쟁점은 마지막에 "D-후보:"로 적는다.
- 한국어로, 간결하게. 대개 3~6문단. 머리말·맺음말 생략.
- 장면 전체를 다시 쓰지 않는다. 수정안이 필요하면 작업실의 "수정안 만들기"를 안내한다.
</answer_style>`;

/** 수정안 자기 검수 체크리스트. 코드는 shared/audit.ts와 같다. */
export const CHECKLIST = [
  ['C1', '판정서 위반 없음 (관련 R/D 번호 확인)'],
  ['C2', '작가 확정 표현 무변경'],
  ['C3', '하나의 행동의 부분인가 (빼면 무엇이 무너지는가)'],
  ['C4', '가치 전환이 있다 (시작≠끝), 수단은 행동 또는 폭로'],
  ['C5', '목표·장애·결과가 화면으로 보인다'],
  ['C6', "직전 장면과 '그래서/그러나'로 연결, '그리고 나서' 없음"],
  ['C7', '우연은 앞의 셋업에서 나왔다 / 데우스 엑스 마키나 없음'],
  ['C8', '하드 규칙 전부 준수 (V.O. 금지 등, 해당 H 번호를 적을 것)'],
  ['C9', '인물이 금지어·주제어를 말하지 않음 (〈극중극〉 예외)'],
  ['C10', '횟수 한도 태그(<counters>)를 넘지 않음'],
  ['C11', '모티프는 등록된 것만, 셋업/회수 짝이 맞음'],
  ['C12', '시점 규칙 (시점 인물이 모르는 정보가 화면에 없음)'],
  ['C13', '대사가 전술로 작동, 원하는 것을 직접 말하지 않음'],
  ['C14', '지문은 현재형·촬영 가능한 것만, 감정 형용사 남용 없음'],
  ['C15', '반클리셰 메모의 흔한 처리 3가지를 피했다'],
  ['C16', '사실 주장에 고증 표지가 붙었다'],
  ['C17', '실존 작품 대사 인용·재현 없음'],
  ['C18', '재현·수위: 대상화 없음, 성적·폭력 장면은 노출·접촉·카메라 위치가 라이더에 옮길 수 있을 만큼 구체적이고 목표 등급 안'],
] as const;

export const CHECK_CODES = CHECKLIST.map(([c]) => c) as unknown as readonly [string, ...string[]];

/** 수정안 작성 지시 */
export const REVISION_INSTRUCTIONS = `${ROLE}
${AUTHORITY}
${CRAFT_PRINCIPLES}
${RESEARCH_PROTOCOL}
${FORBIDDEN}
<workflow>
STEP 1 읽기: 이 장면과 관련된 판정·하드 규칙·문서 구절을 quotes에 그대로 옮긴다. 관련 판정이 없으면 비워 둔다.
STEP 2 장면 카드: 쓰기 전에 sceneCard를 선언한다 (시점, 목표/장애/결과, 시작 가치→끝 가치, 전환 수단, 직전 장면과의 연결어, 셋업/회수, 수위·재현 메모, 고증 표지).
STEP 3 반클리셰: 관객이 예상할 가장 흔한 처리 3가지를 antiCliche에 적고 피한다.
STEP 4 집필: 장면 전체를 elements로 쓴다.
STEP 5 자기 검수: <checklist> 전 항목을 selfReview에 PASS/FAIL과 한 줄 근거로 적는다. 해당 없는 항목은 PASS로 두고 "해당 없음"이라고 쓴다. 정직하게 판정한다 — FAIL을 숨기지 않는다.
STEP 6 보고: 판정 요청(D-후보)·고증 확인·당사자 컨설턴트 검토·상위 규칙 충돌은 openIssues에, 바뀐 것과 손대지 않은 확정 표현은 changeLog에.
</workflow>
<checklist>
${CHECKLIST.map(([c, t]) => `${c} ${t}`).join('\n')}
</checklist>
<element_rules>
- 첫 요소는 반드시 씬 헤딩(scene). 장소·시간이 바뀌지 않는 한 기존 헤딩 문구를 그대로 쓴다. "S#번호"는 붙이지 않는다.
- 요소 종류: scene(씬 헤딩), action(지문), character(인물 이름만), parenthetical(괄호 지시, 괄호 포함), dialogue(대사), transition(전환), shot(샷), general(일반).
- 대사 앞에는 반드시 character. parenthetical은 character와 dialogue 사이 또는 대사 사이에만.
- 【확정】 요소는 종류와 문장을 그대로 옮긴다. 【확정】, 〈극중극〉, {태그} 표시 자체는 출력하지 않는다.
- 요청과 관계없는 부분은 원문을 최대한 유지한다. 고친 곳이 분명히 보이도록 최소한으로, 그러나 확실하게.
- 작품의 문체(지문 길이, 말투)를 따른다. 원고가 한국어면 한국어로.
</element_rules>`;

export const CARD_INSTRUCTIONS = `<role>너는 시나리오 개발 작업실의 스토리 에디터다. 장면 카드(인덱스 카드)를 작품의 언어로 간결하게 쓴다.</role>
${CRAFT_PRINCIPLES}
<rules>
- 원고에 있는 것만 근거로 쓴다. 장면에서 가치가 바뀌지 않으면 시작 가치와 끝 가치를 같게 적어 문제를 드러낸다 — 꾸며 내지 않는다.
- 직전 장면과의 연결이 '그리고 나서'에 가까우면 그대로 andthen으로 판정한다.
</rules>`;
