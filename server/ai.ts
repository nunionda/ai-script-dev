import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatScope, Project, ScriptElement } from '../shared/types';
import { ELEMENT_TYPES } from '../shared/types';
import { ELEMENT_INFO, getScenes, sceneElements, el } from '../shared/screenplay';

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

export function formatElements(elements: ScriptElement[], sceneNumbers?: Map<string, number>): string {
  return elements
    .map((e) => {
      if (e.type === 'scene') {
        const n = sceneNumbers?.get(e.id);
        return `\n[씬 헤딩] ${n ? `S#${n}. ` : ''}${e.text}`;
      }
      return `[${ELEMENT_INFO[e.type].label}] ${e.text.replace(/\n/g, '\n    ')}`;
    })
    .join('\n')
    .trim();
}

export function projectBible(p: Project): string {
  const scenes = getScenes(p);
  const lines: string[] = [`# 작품: ${p.title}`];
  if (p.genre) lines.push(`장르: ${p.genre}`);
  if (p.logline) lines.push(`로그라인: ${p.logline}`);
  const chars = Object.entries(p.characters).filter(([, c]) => c.description.trim());
  if (chars.length) {
    lines.push('', '## 인물 설정');
    for (const [name, c] of chars) lines.push(`- ${name}: ${c.description}`);
  }
  if (p.decisions.length) {
    lines.push('', '## 팀이 함께 정한 방향 (반드시 지킬 것)');
    for (const d of p.decisions) lines.push(`- ${d}`);
  }
  if (p.openQuestions.length) {
    lines.push('', '## 아직 열어 둔 질문');
    for (const q of p.openQuestions) lines.push(`- ${q}`);
  }
  lines.push('', '## 장면 구성');
  for (const act of p.acts) {
    const inAct = scenes.filter((s) => s.actId === act.id);
    if (!inAct.length) continue;
    lines.push(`### ${act.title}`);
    for (const s of inAct) {
      lines.push(`- S#${s.number}. ${s.heading}${s.meta.synopsis ? ` — ${s.meta.synopsis}` : ''}${s.meta.intent ? ` (의도: ${s.meta.intent})` : ''}`);
    }
  }
  return lines.join('\n');
}

function sceneContext(p: Project, sceneId: string): { number: number; text: string; intent: string } {
  const scenes = getScenes(p);
  const s = scenes.find((x) => x.id === sceneId);
  if (!s) throw new AiError(404, '장면을 찾을 수 없습니다. 원고가 저장되었는지 확인해 주세요.');
  const numbers = new Map(scenes.map((x) => [x.id, x.number]));
  return { number: s.number, text: formatElements(sceneElements(p.elements, sceneId), numbers), intent: s.meta.intent ?? '' };
}

const PARTNER_INSTRUCTIONS = `당신은 시나리오 개발 작업실 "FRAME"의 개발 파트너입니다. 작가와 함께 장편 영화·드라마 시나리오를 발전시킵니다.

원칙:
- 작가의 작품입니다. 결정을 대신 내리지 말고, 선택지와 그 효과를 구체적으로 보여 주세요.
- 일반론보다 지금 장면의 구체적인 행동, 소품, 대사로 이야기하세요. 짧은 예시 대사나 지문을 인용 블록(>)으로 제시하면 좋습니다.
- 감정을 설명하는 대사보다 행동과 서브텍스트로 드러내는 방법을 우선 고려하세요.
- "팀이 함께 정한 방향"은 반드시 존중하세요.
- 답변은 한국어로, 간결하게. 대개 3~6문단 이내로 답하고 머리말이나 맺음말은 생략하세요.
- 원고 전체를 다시 쓰라는 요청이 아니면 장면 전체를 재작성하지 마세요. 작가가 "수정안"을 원하면 작업실의 "수정안 만들기" 기능을 쓰도록 안내할 수 있습니다.`;

// ---------------------------------------------------------------- chat

export interface ChatRequest {
  project: Project;
  sceneId: string;
  scope: ChatScope;
  history: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export async function streamChat(req: ChatRequest): Promise<string> {
  const { project, sceneId, scope, history } = req;
  const context: string[] = [projectBible(project)];
  const numbers = new Map(getScenes(project).map((s) => [s.id, s.number]));
  if (scope === 'script') {
    context.push('## 원고 전체', formatElements(project.elements, numbers));
  }
  if (sceneId !== 'project') {
    const sc = sceneContext(project, sceneId);
    context.push(`## 지금 논의 중인 장면: S#${sc.number}${sc.intent ? `\n장면의 의도: ${sc.intent}` : ''}`, sc.text);
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new AiError(400, '보낼 메시지가 없습니다.');

  if (PROVIDER === 'ollama') {
    const system: OllamaMessage = { role: 'system', content: `${PARTNER_INSTRUCTIONS}\n\n${context.join('\n\n')}` };
    return ollamaStream([system, ...(messages as OllamaMessage[])], req.signal, req.onText);
  }

  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [
        { type: 'text', text: PARTNER_INSTRUCTIONS },
        { type: 'text', text: context.join('\n\n'), cache_control: { type: 'ephemeral' } },
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

const ProposalSchema = z.object({
  title: z.string().describe('수정안의 짧은 제목 (예: "말하지 않는 갈등")'),
  rationale: z.string().describe('무엇을 왜 바꾸었는지 2~3문장으로 설명하는 제안 의도'),
  elements: z
    .array(
      z.object({
        type: z.enum(ELEMENT_TYPES).describe('시나리오 요소 종류'),
        text: z.string(),
      }),
    )
    .describe('씬 헤딩부터 시작하는 수정된 장면 전체'),
});

const REVISION_INSTRUCTIONS = `당신은 시나리오 개발 작업실 "FRAME"의 개발 파트너입니다. 작가의 요청에 따라 한 장면의 수정안을 씁니다.

규칙:
- 장면 전체를 요소 목록으로 돌려주세요. 첫 요소는 반드시 씬 헤딩(scene)이고, 장소·시간이 바뀌지 않는 한 기존 헤딩 문구를 그대로 쓰세요. "S#번호"는 붙이지 마세요.
- 요소 종류: scene(씬 헤딩), action(지문), character(인물 이름만), parenthetical(괄호 지시, 괄호 포함), dialogue(대사), transition(전환), shot(샷), general(일반).
- 대사(dialogue) 앞에는 반드시 character가 와야 합니다. parenthetical은 character와 dialogue 사이 또는 대사 사이에만 둡니다.
- 요청과 관계없는 부분은 원문을 최대한 유지하세요. 고친 곳이 분명히 보이도록 최소한으로, 그러나 확실하게 바꾸세요.
- 작품의 문체(지문 길이, 말투)를 따르세요. 원고가 한국어면 한국어로 씁니다.
- "팀이 함께 정한 방향"을 지키세요.`;

export interface ProposalDraft {
  title: string;
  rationale: string;
  original: ScriptElement[];
  revised: ScriptElement[];
}

export async function generateProposal(project: Project, sceneId: string, instruction: string, signal?: AbortSignal): Promise<ProposalDraft> {
  const sc = sceneContext(project, sceneId);
  const original = sceneElements(project.elements, sceneId);
  const userContent = `## 수정할 장면: S#${sc.number}${sc.intent ? `\n장면의 의도: ${sc.intent}` : ''}\n\n${sc.text}\n\n## 작가의 요청\n${instruction.trim() || '장면을 더 날카롭게 다듬어 주세요.'}`;
  let parsed: z.infer<typeof ProposalSchema> | null;
  if (PROVIDER === 'ollama') {
    parsed = await ollamaParse(
      ProposalSchema,
      [
        { role: 'system', content: `${REVISION_INSTRUCTIONS}\n\n${projectBible(project)}` },
        { role: 'user', content: userContent },
      ],
      signal,
    );
  } else {
    const response = await getClient().beta.messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: betaZodOutputFormat(ProposalSchema) },
        system: [
          { type: 'text', text: REVISION_INSTRUCTIONS },
          { type: 'text', text: projectBible(project), cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userContent }],
        ...FALLBACK,
      },
      { signal },
    );
    if (response.stop_reason === 'refusal') throw new AiError(422, '이 장면에 대한 수정안을 만들 수 없다는 응답을 받았습니다.');
    if (response.stop_reason === 'max_tokens') throw new AiError(502, '수정안이 너무 길어 중간에 잘렸습니다. 요청 범위를 좁혀 주세요.');
    parsed = response.parsed_output;
  }
  if (!parsed) throw new AiError(502, '수정안 형식을 해석하지 못했습니다. 다시 시도해 주세요.');
  const revised = parsed.elements.filter((e) => e.text.trim()).map((e) => el(e.type, e.text.trim()));
  if (!revised.length || revised[0].type !== 'scene') revised.unshift(el('scene', original[0]?.text ?? ''));
  return { title: parsed.title.trim(), rationale: parsed.rationale.trim(), original, revised };
}

// ---------------------------------------------------------------- scene card

const CardSchema = z.object({
  synopsis: z.string().describe('장면 카드에 쓸 1~2문장 요약. 현재형, 행동 중심.'),
  intent: z.string().describe('이 장면이 이야기에서 맡는 역할이나 의도를 한 문장으로'),
});

export async function generateSceneCard(project: Project, sceneId: string): Promise<{ synopsis: string; intent: string }> {
  const sc = sceneContext(project, sceneId);
  const instructions = '당신은 시나리오 개발 작업실의 스토리 에디터입니다. 장면 카드(인덱스 카드)를 작품의 언어로 간결하게 씁니다.';
  const userContent = `다음 장면의 카드를 써 주세요.\n\n${sc.text}`;
  if (PROVIDER === 'ollama') {
    const card = await ollamaParse(CardSchema, [
      { role: 'system', content: `${instructions}\n\n${projectBible(project)}` },
      { role: 'user', content: userContent },
    ]);
    return { synopsis: card.synopsis.trim(), intent: card.intent.trim() };
  }
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: betaZodOutputFormat(CardSchema) },
    system: [
      { type: 'text', text: instructions },
      { type: 'text', text: projectBible(project), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userContent }],
    ...FALLBACK,
  });
  if (response.stop_reason === 'refusal') throw new AiError(422, '이 장면의 요약을 만들 수 없다는 응답을 받았습니다.');
  if (!response.parsed_output) throw new AiError(502, '요약 형식을 해석하지 못했습니다.');
  return { synopsis: response.parsed_output.synopsis.trim(), intent: response.parsed_output.intent.trim() };
}
