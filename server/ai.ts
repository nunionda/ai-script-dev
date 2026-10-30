import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuditFinding, ChatMessage, ChatScope, ChecklistResult, OpenIssue, Project, ReferenceDocument, SceneCard, ScriptElement } from '../shared/types';
import { ELEMENT_TYPES } from '../shared/types';
import { carryIds, el, sceneElements } from '../shared/screenplay';
import { auditRevision } from '../shared/audit';
import { CARD_INSTRUCTIONS, CHECK_CODES, PARTNER_INSTRUCTIONS, REVISION_INSTRUCTIONS, bibleBlock, documentsBlock, sceneBlock } from './prompts';

// FRAME_PROVIDER=ollama 이면 로컬 Ollama 서버로, 아니면 Claude API로 보낸다.
export const PROVIDER: 'anthropic' | 'ollama' = process.env.FRAME_PROVIDER === 'ollama' ? 'ollama' : 'anthropic';
export const MODEL = process.env.FRAME_MODEL || (PROVIDER === 'ollama' ? 'gemma4:12b' : 'claude-opus-5-5');
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
// Ollama 기본 문맥은 짧아서 원고 전체를 넣으면 앞부분이 잘린다.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 32768;

// 안전 분류기가 요청을 거절하면 서버 측에서 권장 모델로 다시 실행한다.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export function aiStatus() {
  const configured =
    PROVIDER === 'ollama' ||
    Boolean(
      process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        process.env.ANTHROPIC_PROFILE ||
        existsSync(join(homedir(), '.config', 'anthropic')),
    );
  return { configured, model: MODEL, provider: PROVIDER };
}

export class AiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError(401, 'Claude API 인증에 실패했습니다. ANTHROPIC_API_KEY를 확인해 주세요.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError(403, '이 API 키로는 요청한 모델을 사용할 수 없습니다.');
  if (err instanceof Anthropic.RateLimitError) return new AiError(429, '요청이 많아 잠시 제한되었습니다. 조금 뒤 다시 시도해 주세요.');
  if (err instanceof Anthropic.BadRequestError) return new AiError(400, `요청이 거부되었습니다: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AiError(502, 'Claude API에 연결할 수 없습니다. 네트워크를 확인해 주세요.');
  if (err instanceof Anthropic.APIError) return new AiError(err.status ?? 500, `Claude API 오류: ${err.message}`);
  if (PROVIDER === 'ollama' && err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return new AiError(502, `Ollama(${OLLAMA_URL})에 연결할 수 없습니다. Ollama가 실행 중인지 확인해 주세요.`);
  }
  if (err instanceof z.ZodError || err instanceof SyntaxError) {
    return new AiError(502, '모델 응답 형식을 해석하지 못했습니다. 다시 시도해 주세요.');
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/authentication|api key|apiKey|credentials/i.test(message)) {
    return new AiError(401, 'Claude API 자격 증명이 없습니다. 서버를 실행할 때 ANTHROPIC_API_KEY를 설정해 주세요.');
  }
  return new AiError(500, message);
}

// ---------------------------------------------------------------- ollama

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

async function ollamaRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, think: false, options: { num_ctx: OLLAMA_NUM_CTX }, ...body }),
    signal,
  });
  if (res.ok) return res;
  const detail = await res.text().catch(() => '');
  if (res.status === 404) throw new AiError(502, `Ollama에 ${MODEL} 모델이 없습니다. "ollama pull ${MODEL}"로 받아 주세요.`);
  throw new AiError(502, `Ollama 오류 (${res.status}): ${detail.slice(0, 300)}`);
}

async function ollamaStream(messages: OllamaMessage[], signal: AbortSignal, onText: (delta: string) => void): Promise<string> {
  const res = await ollamaRequest({ messages, stream: true }, signal);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let text = '';
  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChunk;
    if (chunk.error) throw new AiError(502, `Ollama 오류: ${chunk.error}`);
    const delta = chunk.message?.content;
    if (delta) {
      text += delta;
      onText(delta);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    lines.forEach(handle);
  }
  handle(buffer);
  return text;
}

async function ollamaParse<T extends z.ZodType>(schema: T, messages: OllamaMessage[], signal?: AbortSignal): Promise<z.infer<T>> {
  const res = await ollamaRequest({ messages, stream: false, format: z.toJSONSchema(schema), options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0.7 } }, signal);
  const chunk = (await res.json()) as OllamaChunk;
  if (chunk.error) throw new AiError(502, `Ollama 오류: ${chunk.error}`);
  if (chunk.done_reason === 'length') throw new AiError(502, '응답이 너무 길어 중간에 잘렸습니다. 요청 범위를 좁혀 주세요.');
  return schema.parse(JSON.parse(chunk.message?.content ?? ''));
}

// ---------------------------------------------------------------- context

/** 작품 문맥: 판정서·참고 문서(·원고) → 바이블. 시스템 프롬프트 맨 앞에 둔다. */
export function projectContext(project: Project, documents: ReferenceDocument[], opts: { script?: boolean } = {}): string {
  return `${documentsBlock(project, documents, opts)}\n\n${bibleBlock(project)}`;
}

export function requireScene(project: Project, sceneId: string) {
  const sc = sceneBlock(project, sceneId);
  if (!sc) throw new AiError(404, '장면을 찾을 수 없습니다. 원고가 저장되었는지 확인해 주세요.');
  return sc;
}

export function currentSceneText(sc: { label: string; text: string; card: string }, note: string): string {
  return `<current_scene label="S#${sc.label}" note="${note}">\n${sc.card ? `<scene_card>\n${sc.card}\n</scene_card>\n` : ''}${sc.text}\n</current_scene>`;
}

// ---------------------------------------------------------------- chat

export interface ChatRequest {
  project: Project;
  documents: ReferenceDocument[];
  sceneId: string;
  scope: ChatScope;
  history: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export async function streamChat(req: ChatRequest): Promise<string> {
  const { project, sceneId, scope, history } = req;
  const context = projectContext(project, req.documents, { script: scope === 'script' });
  const scene = sceneId !== 'project' ? currentSceneText(requireScene(project, sceneId), '지금 논의 중인 장면') : '';

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new AiError(400, '보낼 메시지가 없습니다.');

  if (PROVIDER === 'ollama') {
    const system: OllamaMessage = { role: 'system', content: [context, PARTNER_INSTRUCTIONS, scene].filter(Boolean).join('\n\n') };
    return ollamaStream([system, ...(messages as OllamaMessage[])], req.signal, req.onText);
  }

  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // 작품 문맥 + 지시까지 캐시하고, 장면별로 바뀌는 부분은 그 뒤에 둔다
      system: [
        { type: 'text', text: context },
        { type: 'text', text: PARTNER_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
        ...(scene ? [{ type: 'text' as const, text: scene }] : []),
      ],
      messages,
      ...FALLBACK,
    },
    { signal: req.signal },
  );

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') req.onText(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new AiError(422, '이 요청에는 답할 수 없다는 응답을 받았습니다. 표현을 바꿔 다시 요청해 주세요.');
  }
  return final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ---------------------------------------------------------------- revision proposal

const CardFields = {
  pov: z.string().describe('시점 인물'),
  goal: z.string().describe('이 장면에서 누가 무엇을 원하는가'),
  obstacle: z.string().describe('무엇이 막는가'),
  outcome: z.string().describe('어떻게 끝나는가'),
  valueStart: z.string().describe('시작 가치와 부호 (예: "신뢰 +")'),
  valueEnd: z.string().describe('끝 가치와 부호 (예: "불신 −")'),
  turnBy: z.enum(['action', 'revelation']).describe('전환 수단: 행동 또는 폭로'),
  link: z.enum(['therefore', 'but', 'andthen']).describe('직전 장면과의 연결어: 그래서 / 그러나 / 그리고 나서'),
};

const ProposalSchema = z.object({
  quotes: z
    .array(z.object({ source: z.string().describe('판정·규칙 번호나 문서 이름 (예: R3, H2, 시놉시스)'), text: z.string().describe('그대로 옮긴 구절') }))
    .describe('STEP 1: 관련 판정·규칙·문서 구절'),
  sceneCard: z
    .object({
      ...CardFields,
      setups: z.string().describe('이 장면의 셋업/회수 (모티프·소품·정보와 관련 장면 번호)'),
      ratingNote: z.string().describe('수위·재현 메모. 없으면 "없음"'),
      research: z.string().describe('고증 표지 요약 ([확인]/[추정]/[작가확인필요])'),
    })
    .describe('STEP 2: 쓰기 전에 선언하는 장면 카드'),
  antiCliche: z.array(z.string()).describe('STEP 3: 관객이 예상할 흔한 처리 3가지 (피한 것)'),
  elements: z
    .array(z.object({ type: z.enum(ELEMENT_TYPES).describe('시나리오 요소 종류'), text: z.string() }))
    .describe('STEP 4: 씬 헤딩부터 시작하는 수정된 장면 전체'),
  selfReview: z
    .array(z.object({ code: z.enum(CHECK_CODES), pass: z.boolean(), note: z.string().describe('한 줄 근거') }))
    .describe('STEP 5: 체크리스트 전 항목'),
  openIssues: z
    .array(
      z.object({
        kind: z
          .enum(['ruling', 'research', 'consultant', 'conflict'])
          .describe('ruling=판정 요청(D-후보), research=고증 확인, consultant=당사자 컨설턴트 검토, conflict=상위 규칙과 충돌'),
        text: z.string(),
      }),
    )
    .describe('STEP 6: 작가에게 올릴 미결 쟁점'),
  title: z.string().describe('수정안의 짧은 제목 (예: "말하지 않는 갈등")'),
  rationale: z.string().describe('무엇을 왜 바꾸었는지 2~3문장'),
  changeLog: z.string().describe('바뀐 것 / 손대지 않은 확정 표현'),
});

type ParsedProposal = z.infer<typeof ProposalSchema>;

/** 자기 검수 FAIL이 남으면 다시 쓰게 하는 최대 횟수 */
const MAX_REWRITES = 2;

export interface ProposalDraft {
  title: string;
  rationale: string;
  original: ScriptElement[];
  revised: ScriptElement[];
  quotes: { source: string; text: string }[];
  sceneCard: SceneCard;
  antiCliche: string[];
  selfReview: ChecklistResult[];
  audit: AuditFinding[];
  openIssues: OpenIssue[];
  changeLog: string;
  rewrites: number;
}

export type Turn = { role: 'user' | 'assistant'; content: string };

export interface StructuredOptions {
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  /** 거절 응답일 때 보일 문장 */
  refusal: string;
  signal?: AbortSignal;
}

/** 구조화 출력 호출. 시스템 블록의 마지막에 캐시 지점을 둔다. */
export async function structured<T extends z.ZodType>(schema: T, system: string[], messages: Turn[], opts: StructuredOptions): Promise<z.infer<T>> {
  if (PROVIDER === 'ollama') {
    return ollamaParse(schema, [{ role: 'system', content: system.join('\n\n') }, ...messages], opts.signal);
  }
  const response = await getClient().beta.messages.parse(
    {
      model: MODEL,
      max_tokens: opts.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort, format: betaZodOutputFormat(schema) },
      system: system.map((text, i) =>
        i === system.length - 1 ? { type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } } : { type: 'text' as const, text },
      ),
      messages,
      ...FALLBACK,
    },
    { signal: opts.signal },
  );
  if (response.stop_reason === 'refusal') throw new AiError(422, opts.refusal);
  if (response.stop_reason === 'max_tokens') throw new AiError(502, '응답이 너무 길어 중간에 잘렸습니다. 요청 범위를 좁혀 주세요.');
  if (!response.parsed_output) throw new AiError(502, '모델 응답 형식을 해석하지 못했습니다. 다시 시도해 주세요.');
  return response.parsed_output as z.infer<T>;
}

function parseProposal(system: string[], messages: Turn[], signal?: AbortSignal): Promise<ParsedProposal> {
  return structured(ProposalSchema, system, messages, {
    maxTokens: 16000,
    effort: 'high',
    refusal: '이 장면에 대한 수정안을 만들 수 없다는 응답을 받았습니다.',
    signal,
  });
}

/**
 * 장면 카드 선언 → 집필 → 자기 검수. 코드 점검이나 자기 검수에 FAIL이 남으면
 * 그 목록을 돌려주고 다시 쓰게 한다 (최대 2회). 그래도 남으면 그대로 보고한다.
 */
export async function generateProposal(
  project: Project,
  documents: ReferenceDocument[],
  sceneId: string,
  instruction: string,
  signal?: AbortSignal,
): Promise<ProposalDraft> {
  const sc = requireScene(project, sceneId);
  const original = sceneElements(project.elements, sceneId);
  const system = [projectContext(project, documents), REVISION_INSTRUCTIONS];
  const messages: Turn[] = [
    {
      role: 'user',
      content: `${currentSceneText(sc, '수정할 장면')}\n\n<task>\n${instruction.trim() || '장면을 더 날카롭게 다듬어 주세요.'}\n</task>`,
    },
  ];

  for (let rewrites = 0; ; rewrites++) {
    const parsed = await parseProposal(system, messages, signal);
    const written = parsed.elements
      .filter((e) => e.text.trim())
      // 문맥에 붙여 준 장면 번호를 모델이 헤딩에 옮겨 쓰는 경우가 있다
      .map((e) => el(e.type, e.type === 'scene' ? e.text.trim().replace(/^S#\s*[\w-]+\.\s*/i, '') : e.text.trim()));
    if (!written.length || written[0].type !== 'scene') written.unshift(el('scene', original[0]?.text ?? ''));
    const revised = carryIds(original, written);
    const audit = auditRevision(project, sceneId, revised);
    const failed = [
      ...audit.filter((f) => f.level === 'fail').map((f) => `${f.code} (코드 점검) ${f.message}`),
      ...parsed.selfReview.filter((r) => !r.pass).map((r) => `${r.code} (자기 검수) ${r.note}`),
    ];
    if (!failed.length || rewrites >= MAX_REWRITES) {
      return {
        title: parsed.title.trim(),
        rationale: parsed.rationale.trim(),
        original,
        revised,
        quotes: parsed.quotes,
        sceneCard: parsed.sceneCard,
        antiCliche: parsed.antiCliche,
        selfReview: parsed.selfReview,
        audit,
        openIssues: parsed.openIssues,
        changeLog: parsed.changeLog.trim(),
        rewrites,
      };
    }
    messages.push(
      { role: 'assistant', content: JSON.stringify(parsed) },
      {
        role: 'user',
        content: `다음 항목이 FAIL입니다. 고쳐서 전체를 다시 제출하세요. 고칠 수 없는 항목은 FAIL로 두고 openIssues에 이유를 적으세요.\n${failed.map((f) => `- ${f}`).join('\n')}`,
      },
    );
  }
}

// ---------------------------------------------------------------- scene card

const CardSchema = z.object({
  synopsis: z.string().describe('장면 카드에 쓸 1~2문장 요약. 현재형, 행동 중심.'),
  intent: z.string().describe('이 장면이 이야기에서 맡는 역할이나 의도를 한 문장으로'),
  ...CardFields,
});

export type GeneratedCard = z.infer<typeof CardSchema>;

export async function generateSceneCard(project: Project, documents: ReferenceDocument[], sceneId: string): Promise<GeneratedCard> {
  const sc = requireScene(project, sceneId);
  const card = await structured(
    CardSchema,
    [projectContext(project, documents), CARD_INSTRUCTIONS],
    [{ role: 'user', content: `다음 장면의 카드를 써 주세요.\n\n${currentSceneText(sc, '카드를 쓸 장면')}` }],
    { maxTokens: 4000, effort: 'low', refusal: '이 장면의 요약을 만들 수 없다는 응답을 받았습니다.' },
  );
  return { ...card, synopsis: card.synopsis.trim(), intent: card.intent.trim() };
}
