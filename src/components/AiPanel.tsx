import { useEffect, useRef, useState } from 'react';
import { Check, ListChecks, LockKeyhole, Send, Share2, Sparkles, Square, Trash2, Wand2 } from 'lucide-react';
import type { ChatMessage, ChatScope, ChatSummary, SceneComment } from '../../shared/types';
import { uid } from '../../shared/screenplay';
import { api, sendChat } from '../api';
import { loadMe, saveMe, useProject, usePref, type Me } from '../state';
import { Markdown } from './Markdown';
import { go, projectPath, timeAgo, useAnnounce } from '../ui';

interface Props {
  projectId: string;
  sceneId: string | null;
  sceneLabel: string;
  comments: SceneComment[];
  onCommentsChange: () => void;
  aiConfigured: boolean | null;
}

export function AiPanel({ projectId, sceneId, sceneLabel, comments, onCommentsChange, aiConfigured }: Props) {
  const [tab, setTab] = usePref<'ai' | 'team'>('aiTab', 'ai');
  const sceneComments = comments.filter((c) => c.sceneId === (sceneId ?? 'project'));
  const open = sceneComments.filter((c) => !c.resolved).length;

  return (
    <aside className="ai" aria-label="개발 파트너">
      <div className="ai-heading">
        <span className="ai-mark" aria-hidden="true">
          ✳
        </span>
        <div>
          <h2>개발 파트너</h2>
          <span className="muted small">장면에 연결된 AI 논의와 팀 의견</span>
        </div>
      </div>
      <div className="ai-tabs" role="tablist" aria-label="논의 유형">
        <button role="tab" aria-selected={tab === 'ai'} onClick={() => setTab('ai')}>
          AI와 상의
        </button>
        <button role="tab" aria-selected={tab === 'team'} onClick={() => setTab('team')}>
          팀 의견 {open > 0 && <span className="count">{open}</span>}
        </button>
      </div>
      {tab === 'ai' ? (
        <AiChat projectId={projectId} sceneId={sceneId ?? 'project'} sceneLabel={sceneLabel} aiConfigured={aiConfigured} onShared={onCommentsChange} />
      ) : (
        <TeamComments projectId={projectId} sceneId={sceneId ?? 'project'} comments={sceneComments} onChange={onCommentsChange} />
      )}
    </aside>
  );
}

function AiChat({
  projectId,
  sceneId,
  sceneLabel,
  aiConfigured,
  onShared,
}: {
  projectId: string;
  sceneId: string;
  sceneLabel: string;
  aiConfigured: boolean | null;
  onShared: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = usePref<ChatScope>('chatScope', 'scene');
  const [proposalOpen, setProposalOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [proposing, setProposing] = useState(false);
  const [summary, setSummary] = useState<ChatSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const announce = useAnnounce();
  const isScene = sceneId !== 'project';

  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError('');
    setSummary(null);
    api
      .listChat(projectId, sceneId)
      .then((m) => alive && setMessages(m))
      .catch(() => undefined);
    return () => {
      alive = false;
      abort.current?.abort();
    };
  }, [projectId, sceneId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, streaming]);

  const send = async () => {
    const content = draft.trim();
    if (!content || streaming !== null) return;
    setDraft('');
    setError('');
    setStreaming('');
    const controller = new AbortController();
    abort.current = controller;
    let acc = '';
    await sendChat(
      projectId,
      { sceneId, scope, content, author: loadMe().name || '작가' },
      {
        onUser: (m) => setMessages((ms) => [...ms, m]),
        onDelta: (t) => {
          acc += t;
          setStreaming(acc);
        },
        onDone: (m) => setMessages((ms) => [...ms, m]),
        onError: (msg) => {
          setError(msg);
          if (!acc) setDraft((d) => d || content);
        },
      },
      controller.signal,
    );
    if (controller.signal.aborted && acc) {
      setMessages((ms) => [...ms, { id: `local-${Date.now()}`, projectId, sceneId, role: 'assistant', author: '개발 파트너', content: acc + '\n\n(중단됨)', createdAt: new Date().toISOString() }]);
    }
    setStreaming(null);
    abort.current = null;
  };

  const share = async (m: ChatMessage) => {
    const me = loadMe();
    await api.addComment(projectId, { sceneId, author: me.name || '작가', role: me.role, text: `AI 개발 파트너의 제안을 공유합니다:\n\n${m.content}` });
    onShared();
    announce('AI 답변을 팀 의견으로 공유했습니다.');
  };

  const propose = async () => {
    setProposing(true);
    setError('');
    try {
      const p = await api.createProposal(projectId, sceneId, instruction);
      announce('수정안이 도착했습니다. 원문과 비교해 보세요.');
      go(projectPath(projectId, 'review', p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '수정안을 만들지 못했습니다.');
      setProposing(false);
    }
  };

  const summarize = async () => {
    setSummarizing(true);
    setError('');
    try {
      setSummary(await api.summarizeChat(projectId, sceneId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '대화를 정리하지 못했습니다.');
    } finally {
      setSummarizing(false);
    }
  };

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  return (
    <div className="ai-body">
      <div className="context">
        <span>참조 범위</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as ChatScope)} aria-label="AI가 참조할 범위">
          <option value="scene">{isScene ? `${sceneLabel} · 인물 설정` : '작품 설정 · 장면 구성'}</option>
          <option value="script">원고 전체 · 인물 설정</option>
        </select>
      </div>

      {aiConfigured === false && (
        <div className="notice">
          <Sparkles aria-hidden="true" />
          <p>
            AI 자격 증명이 설정되지 않았습니다. 서버를 <code>ANTHROPIC_API_KEY</code> 환경 변수와 함께 실행하면 개발 파트너가 활성화됩니다.
          </p>
        </div>
      )}

      <div className="chat-log" ref={logRef} aria-live="polite">
        {!messages.length && streaming === null && (
          <p className="muted small empty-chat">
            {isScene ? `${sceneLabel}에 대해 상의해 보세요. 예: “아버지가 감정을 직접 말하지 않았으면 해. 행동으로 표현할 수 있을까?”` : '작품 전체의 방향, 구조, 인물에 대해 상의해 보세요.'}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`message${m.role === 'user' ? ' message-user' : ''}`}>
            <span className="message-meta">
              {m.role === 'user' ? `${m.author} · 작가` : '개발 파트너'} · {timeAgo(m.createdAt)}
            </span>
            {m.role === 'user' ? <p>{m.content}</p> : <Markdown text={m.content} />}
            {m.role === 'assistant' && !m.id.startsWith('local-') && (
              <button className="link-btn" onClick={() => void share(m)}>
                <Share2 aria-hidden="true" />팀과 공유
              </button>
            )}
          </div>
        ))}
        {streaming !== null && (
          <div className="message">
            <span className="message-meta">개발 파트너 · 작성 중</span>
            {streaming ? <Markdown text={streaming} /> : <p className="typing">생각하는 중…</p>}
          </div>
        )}
      </div>

      {summary && <SessionSummary summary={summary} onClose={() => setSummary(null)} />}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          rows={3}
          placeholder={isScene ? '이 장면에 대해 물어보세요' : '작품에 대해 물어보세요'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="AI에게 보낼 메시지"
        />
        {streaming !== null ? (
          <button type="button" className="icon-btn" onClick={() => abort.current?.abort()} aria-label="응답 중단">
            <Square aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="icon-btn primary" disabled={!draft.trim()} aria-label="보내기">
            <Send aria-hidden="true" />
          </button>
        )}
      </form>

      {isScene && (
        <div className="proposal-box">
          {!proposalOpen ? (
            <button
              className="primary wide"
              onClick={() => {
                setInstruction(lastUser);
                setProposalOpen(true);
              }}
            >
              <Wand2 aria-hidden="true" />이 장면의 수정안 만들기 <span>→</span>
            </button>
          ) : (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void propose();
              }}
            >
              <label>
                무엇을 바꿀까요?
                <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="예: 설명적인 대사를 행동으로 바꿔 줘" autoFocus />
              </label>
              <div className="row">
                <button type="button" onClick={() => setProposalOpen(false)} disabled={proposing}>
                  취소
                </button>
                <button className="primary" type="submit" disabled={proposing}>
                  {proposing ? '수정안을 쓰는 중… (1분 정도 걸릴 수 있어요)' : '수정안 요청'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <div className="ai-footer">
        <LockKeyhole aria-hidden="true" />
        AI 논의는 이 작품에만 저장됩니다 · 선택한 답변만 팀과 공유
        {messages.length > 0 && streaming === null && (
          <button className="link-btn" disabled={summarizing} onClick={() => void summarize()} title="결정 후보와 미결 사항으로 정리 (AI 호출 1회)">
            <ListChecks aria-hidden="true" />
            {summarizing ? '정리 중…' : '세션 정리'}
          </button>
        )}
        {messages.length > 0 && streaming === null && (
          <button
            className="link-btn"
            onClick={async () => {
              if (!confirm('이 장면의 AI 대화를 지울까요?')) return;
              await api.clearChat(projectId, sceneId);
              setMessages([]);
            }}
          >
            대화 지우기
          </button>
        )}
      </div>
    </div>
  );
}

function TeamComments({ projectId, sceneId, comments, onChange }: { projectId: string; sceneId: string; comments: SceneComment[]; onChange: () => void }) {
  const [me, setMe] = useState<Me>(loadMe);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const visible = comments.filter((c) => showResolved || !c.resolved);
  const resolvedCount = comments.filter((c) => c.resolved).length;

  const submit = async () => {
    if (!text.trim() || !me.name.trim()) return;
    setBusy(true);
    saveMe(me);
    try {
      await api.addComment(projectId, { sceneId, author: me.name.trim(), role: me.role, text });
      setText('');
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-body">
      <div className="chat-log">
        {!visible.length && <p className="muted small empty-chat">이 장면에 남긴 의견이 없습니다.</p>}
        {visible.map((c) => (
          <div key={c.id} className={`message comment${c.resolved ? ' comment-resolved' : ''}`}>
            <span className="message-meta">
              {c.author}
              {c.role && ` · ${c.role}`} · {timeAgo(c.createdAt)}
            </span>
            <Markdown text={c.text} />
            <div className="row tight">
              <button
                className="link-btn"
                onClick={async () => {
                  await api.resolveComment(c.id, !c.resolved);
                  onChange();
                }}
              >
                <Check aria-hidden="true" />
                {c.resolved ? '다시 열기' : '해결'}
              </button>
              <button
                className="link-btn"
                onClick={async () => {
                  if (!confirm('이 의견을 삭제할까요?')) return;
                  await api.deleteComment(c.id);
                  onChange();
                }}
              >
                <Trash2 aria-hidden="true" />
                삭제
              </button>
            </div>
          </div>
        ))}
        {resolvedCount > 0 && (
          <button className="link-btn" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? '해결된 의견 숨기기' : `해결된 의견 ${resolvedCount}개 보기`}
          </button>
        )}
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row tight">
          <input aria-label="이름" placeholder="이름" value={me.name} onChange={(e) => setMe({ ...me, name: e.target.value })} required />
          <input aria-label="역할" placeholder="역할 (예: 공동 작가)" value={me.role} onChange={(e) => setMe({ ...me, role: e.target.value })} />
        </div>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="이 장면에 의견 남기기" aria-label="의견" />
        <button className="primary" type="submit" disabled={busy || !text.trim() || !me.name.trim()}>
          의견 남기기
        </button>
      </form>
    </div>
  );
}

/** 세션 정리: 결정 후보는 판정서로, 미결 사항은 열린 질문으로 — 작가가 고른 것만 반영한다 */
function SessionSummary({ summary, onClose }: { summary: ChatSummary; onClose: () => void }) {
  const { project, update } = useProject();
  const announce = useAnnounce();
  const [used, setUsed] = useState<Set<string>>(new Set());
  const mark = (key: string) => setUsed((s) => new Set(s).add(key));

  const addRuling = (text: string) => {
    update((p) => {
      const nums = p.rulings.filter((r) => /^D/i.test(r.code)).map((r) => Number(r.code.replace(/\D/g, '')) || 0);
      return { rulings: [...p.rulings, { id: uid('d'), code: `D${(nums.length ? Math.max(...nums) : 0) + 1}`, text }] };
    });
    announce('판정서에 추가했습니다.');
  };
  const addQuestion = (text: string) => {
    update((p) => ({ openQuestions: [...p.openQuestions, text] }));
    announce('열린 질문에 추가했습니다.');
  };
  const already = (text: string) => project.rulings.some((r) => r.text.trim() === text) || project.openQuestions.includes(text);

  return (
    <div className="session-summary" role="region" aria-label="세션 정리">
      <div className="row">
        <strong>세션 정리</strong>
        <button className="link-btn" onClick={onClose}>
          닫기
        </button>
      </div>
      {!summary.decisions.length && !summary.open.length && <p className="muted small">정리할 결정이나 미결 사항이 없습니다.</p>}
      {summary.decisions.length > 0 && (
        <>
          <h3>결정 후보</h3>
          <ul className="plain-list">
            {summary.decisions.map((d, i) => (
              <li key={`d${i}`}>
                <p className="small">{d}</p>
                <button
                  className="small-btn"
                  disabled={used.has(`d${i}`) || already(d)}
                  onClick={() => {
                    addRuling(d);
                    mark(`d${i}`);
                  }}
                >
                  판정서에 추가
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.open.length > 0 && (
        <>
          <h3>미결 사항</h3>
          <ul className="plain-list">
            {summary.open.map((q, i) => (
              <li key={`o${i}`}>
                <p className="small">{q}</p>
                <button
                  className="small-btn"
                  disabled={used.has(`o${i}`) || already(q)}
                  onClick={() => {
                    addQuestion(q);
                    mark(`o${i}`);
                  }}
                >
                  열린 질문에 추가
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
