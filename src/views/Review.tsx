import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import type { OpenIssueKind, Proposal, ProposalStatus } from '../../shared/types';
import { lockedChanged } from '../../shared/audit';
import { getScenes, replaceScene, sceneElements } from '../../shared/screenplay';
import { diffElements, summarizeDiff, type DiffOp } from '../../shared/diff';
import { api } from '../api';
import { useProject } from '../state';
import { ScriptLine } from '../components/ScriptView';
import { go, projectPath, timeAgo, useAnnounce } from '../ui';

const STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: '검토 대기',
  held: '보류',
  accepted: '채택',
  rejected: '거절',
};

const sameScene = (a: { type: string; text: string }[], b: { type: string; text: string }[]) =>
  a.length === b.length && a.every((x, i) => x.type === b[i].type && x.text.trim() === b[i].text.trim());

export function Review({ proposalId }: { proposalId: string | null }) {
  const { project, update, flush } = useProject();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const announce = useAnnounce();

  useEffect(() => {
    api
      .listProposals(project.id)
      .then(setProposals)
      .catch(() => setProposals([]));
  }, [project.id]);

  const visible = (proposals ?? []).filter((p) => filter === 'all' || p.status === 'pending' || p.status === 'held' || p.id === proposalId);
  const selected = (proposals ?? []).find((p) => p.id === proposalId) ?? visible[0] ?? null;

  const scenes = useMemo(() => getScenes(project), [project]);
  const scene = selected ? scenes.find((s) => s.id === selected.sceneId) : undefined;
  const current = selected && scene ? sceneElements(project.elements, selected.sceneId) : [];
  const ops = useMemo(() => (selected ? diffElements(selected.original, selected.revised) : []), [selected]);
  const summary = summarizeDiff(ops);

  const stale = selected && scene && selected.status !== 'accepted' && !sameScene(current, selected.original);
  const changedSinceAccept = selected && scene && selected.status === 'accepted' && !sameScene(current, selected.revised);
  // 【확정】 요소를 바꾼 수정안은 채택할 수 없다 (서버도 막는다)
  const lockedBroken = selected && scene && selected.status !== 'accepted' ? lockedChanged(current, selected.revised, project.elementMarks) : [];

  const setStatus = async (p: Proposal, status: ProposalStatus) => {
    const saved = await api.setProposalStatus(p.id, status);
    setProposals((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null);
  };

  const accept = async () => {
    if (!selected || !scene) return;
    setBusy(true);
    try {
      await flush();
      await api.createSnapshot(project.id, `수정안 채택 전 · S#${scene.label}`, `"${selected.title}" 채택 직전의 원고`);
      await setStatus(selected, 'accepted');
      update((p) => ({ elements: replaceScene(p.elements, selected.sceneId, selected.revised) }));
      announce('수정안을 원고에 반영했습니다. 채택 직전 원고는 작업본에 저장했습니다.');
    } catch (e) {
      announce(e instanceof Error ? e.message : '수정안을 반영하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!selected || !scene) return;
    if (changedSinceAccept && !confirm('채택 후 이 장면을 고쳤습니다. 채택을 취소하면 그 뒤의 수정도 사라집니다. 계속할까요?')) return;
    update((p) => ({ elements: replaceScene(p.elements, selected.sceneId, selected.original) }));
    await setStatus(selected, 'pending');
    announce('원고를 수정안 채택 전으로 되돌렸습니다.');
  };

  if (proposals === null) return <div className="page muted">불러오는 중…</div>;

  return (
    <div className="page review">
      <div className="review-layout">
        <aside className="proposal-list" aria-label="수정안 목록">
          <div className="row">
            <p className="eyebrow">PROPOSALS</p>
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')} aria-label="표시할 수정안">
              <option value="open">검토할 것</option>
              <option value="all">전체</option>
            </select>
          </div>
          {!visible.length && <p className="muted small">검토할 수정안이 없습니다. 집필 화면의 개발 파트너에게 장면 수정안을 요청해 보세요.</p>}
          {visible.map((p) => {
            const s = scenes.find((x) => x.id === p.sceneId);
            return (
              <button key={p.id} className="proposal-item" aria-current={p.id === selected?.id ? 'true' : undefined} onClick={() => go(projectPath(project.id, 'review', p.id))}>
                <span className={`status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                <strong>{p.title || '장면 수정안'}</strong>
                <span className="muted small">
                  {s ? `S#${s.label} ${s.parts.location}` : '삭제된 장면'} · {timeAgo(p.createdAt)}
                </span>
              </button>
            );
          })}
        </aside>

        {selected ? (
          <section className="review-main">
            <div className="heading">
              <div>
                <p className="eyebrow">REVISION REVIEW</p>
                <h1>{selected.title || '장면 수정안'}</h1>
                <p className="muted">
                  {scene ? `S#${scene.label} ${scene.parts.location}` : '삭제된 장면'}
                  {selected.instruction && ` · 요청: ${selected.instruction}`}
                </p>
              </div>
              <button onClick={() => go(projectPath(project.id, 'write', selected.sceneId))}>← 원고 보기</button>
            </div>

            <div className="review-context">
              <span className="ai-mark" aria-hidden="true">
                ✳
              </span>
              <p>
                <strong>제안 의도</strong> {selected.rationale}
              </p>
              <span className="muted small nowrap">
                고침 {summary.changed} · 추가 {summary.added} · 삭제 {summary.removed}
              </span>
            </div>

            {!scene && (
              <p className="banner banner-warn">
                <TriangleAlert aria-hidden="true" />이 수정안의 장면이 원고에서 삭제되어 반영할 수 없습니다.
              </p>
            )}
            {stale && (
              <p className="banner banner-warn">
                <TriangleAlert aria-hidden="true" />
                수정안을 받은 뒤 원고의 이 장면이 바뀌었습니다. 채택하면 현재 장면 전체가 수정안으로 바뀝니다.
              </p>
            )}

            {lockedBroken && lockedBroken.length > 0 && (
              <p className="banner banner-warn" role="alert">
                <CircleAlert aria-hidden="true" />
                이 수정안은 작가 확정 표현 {lockedBroken.length}곳을 바꿉니다 (예: “{lockedBroken[0].text.slice(0, 40)}”). 확정을 풀거나 수정안을 다시 받아야 채택할 수 있습니다.
              </p>
            )}

            <div className="diff-grid">
              <DiffColumn label="현재 원고" note={selected.status === 'accepted' ? '채택 전' : '작업본'} ops={ops} side="a" />
              <DiffColumn label="AI 수정안" note={STATUS_LABEL[selected.status]} ops={ops} side="b" />
            </div>

            <ProposalReport
              proposal={selected}
              onRaise={(text) => {
                update((p) => ({ openQuestions: [...p.openQuestions, text] }));
                announce('열린 질문에 올렸습니다. 판정이 나면 작품 바이블의 판정서에 적어 주세요.');
              }}
            />

            <div className="review-bottom">
              <div>
                <strong aria-live="polite">
                  {selected.status === 'accepted'
                    ? '수정안을 채택했습니다'
                    : selected.status === 'held'
                      ? '수정안을 보류했습니다'
                      : selected.status === 'rejected'
                        ? '수정안을 거절했습니다'
                        : '작가의 검토를 기다리는 제안'}
                </strong>
                <p className="muted small">
                  {selected.status === 'accepted'
                    ? '원고 보기에서 반영된 장면을 확인할 수 있습니다. 채택 직전 원고는 작업본에 있습니다.'
                    : selected.status === 'held'
                      ? '원고는 그대로입니다. 다시 검토한 뒤 채택할 수 있습니다.'
                      : '채택하면 원고의 이 장면이 수정안으로 바뀝니다.'}
                </p>
              </div>
              <div className="row tight">
                {selected.status === 'accepted' ? (
                  <button onClick={() => void undo()}>채택 취소</button>
                ) : (
                  <>
                    {selected.status !== 'rejected' && <button onClick={() => void setStatus(selected, 'rejected')}>거절</button>}
                    {selected.status !== 'held' && <button onClick={() => void setStatus(selected, 'held')}>보류</button>}
                    <button className="primary" disabled={busy || !scene || Boolean(lockedBroken?.length)} onClick={() => void accept()}>
                      {busy ? '반영 중…' : '수정안 채택'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="review-main empty-state">
            <h1>말 대신, 함께하는 행동으로.</h1>
            <p className="muted">집필 화면에서 장면을 고른 뒤 개발 파트너에게 “이 장면의 수정안 만들기”를 요청하면 여기에서 원문과 비교할 수 있습니다.</p>
            <button className="primary" onClick={() => go(projectPath(project.id, 'write'))}>
              집필 화면으로
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

export function DiffColumn({ label, note, ops, side }: { label: string; note: string; ops: DiffOp[]; side: 'a' | 'b' }) {
  return (
    <article className="diff">
      <div className="diff-label">
        {label} <span>{note}</span>
      </div>
      <div className="script-view">
        {ops.map((op, i) => {
          if (op.kind === 'same') return <ScriptLine key={i} e={side === 'a' ? op.a : op.b} />;
          if (side === 'a' && (op.kind === 'del' || op.kind === 'change')) return <ScriptLine key={i} e={op.a} className="removed" />;
          if (side === 'b' && (op.kind === 'add' || op.kind === 'change')) return <ScriptLine key={i} e={op.b} className="added" />;
          return null;
        })}
      </div>
    </article>
  );
}

const ISSUE_LABEL: Record<OpenIssueKind, string> = {
  ruling: '판정 요청 (D-후보)',
  research: '고증 확인',
  consultant: '컨설턴트 검토',
  conflict: '상위 규칙과 충돌',
};

const CARD_ROWS: [keyof Proposal['sceneCard'], string][] = [
  ['pov', '시점 인물'],
  ['goal', '목표'],
  ['obstacle', '장애'],
  ['outcome', '결과'],
  ['setups', '셋업 / 회수'],
  ['ratingNote', '수위·재현'],
  ['research', '고증'],
];

const LINK_LABEL = { therefore: '그래서', but: '그러나', andthen: '그리고 나서' } as const;
const TURN_LABEL = { action: '행동', revelation: '폭로' } as const;

/** 수정안 작성 과정: 인용 근거 → 장면 카드 → 반클리셰 → 자기 검수·코드 점검 → 미결 쟁점 */
function ProposalReport({ proposal, onRaise }: { proposal: Proposal; onRaise: (text: string) => void }) {
  const p = proposal;
  const fails = p.selfReview.filter((r) => !r.pass).length + p.audit.filter((f) => f.level === 'fail').length;
  const card = p.sceneCard;
  if (!p.selfReview.length && !p.quotes.length && !p.audit.length) return null;
  return (
    <details className="proposal-report" open={fails > 0 || p.openIssues.length > 0}>
      <summary>
        작성 과정과 검수 — 검수 FAIL {fails}
        {p.rewrites > 0 && ` · 자기 검수 뒤 ${p.rewrites}번 다시 씀`}
        {p.openIssues.length > 0 && ` · 미결 쟁점 ${p.openIssues.length}`}
      </summary>
      <div className="report-grid">
        {p.quotes.length > 0 && (
          <section>
            <h3>근거로 인용한 판정·규칙</h3>
            {p.quotes.map((q, i) => (
              <blockquote key={i}>
                <strong>{q.source}</strong> {q.text}
              </blockquote>
            ))}
          </section>
        )}
        <section>
          <h3>장면 카드</h3>
          <dl className="card-dl">
            {(card.valueStart || card.valueEnd) && (
              <div className="dl-row">
                <dt>가치 전환</dt>
                <dd>
                  {card.valueStart} → {card.valueEnd}
                  {card.turnBy && ` (${TURN_LABEL[card.turnBy]})`}
                </dd>
              </div>
            )}
            {card.link && (
              <div className="dl-row">
                <dt>직전 장면과</dt>
                <dd className={card.link === 'andthen' ? 'fail-text' : undefined}>{LINK_LABEL[card.link]}</dd>
              </div>
            )}
            {CARD_ROWS.filter(([k]) => card[k]).map(([k, label]) => (
              <div key={k} className="dl-row">
                <dt>{label}</dt>
                <dd>{String(card[k])}</dd>
              </div>
            ))}
          </dl>
          {p.antiCliche.length > 0 && (
            <>
              <h3>피한 흔한 처리</h3>
              <ol className="small">
                {p.antiCliche.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            </>
          )}
        </section>
        <section className="span-2">
          <h3>검수</h3>
          <ul className="plain-list findings">
            {p.audit.map((f, i) => (
              <li key={`a${i}`} className={`finding finding-${f.level}`}>
                {f.level === 'fail' ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
                <span className="code">{f.code}</span> 코드 점검 · {f.message}
              </li>
            ))}
            {p.selfReview.map((r) => (
              <li key={r.code} className={`finding ${r.pass ? 'finding-pass' : 'finding-fail'}`}>
                {r.pass ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
                <span className="code">{r.code}</span> {r.note}
              </li>
            ))}
          </ul>
        </section>
        {p.openIssues.length > 0 && (
          <section className="span-2">
            <h3>미결 쟁점</h3>
            <ul className="plain-list">
              {p.openIssues.map((o, i) => (
                <li key={i} className="row">
                  <span>
                    <span className="tag">{ISSUE_LABEL[o.kind]}</span> {o.text}
                  </span>
                  <button className="small-btn" onClick={() => onRaise(`${o.kind === 'ruling' ? 'D-후보: ' : `${ISSUE_LABEL[o.kind]}: `}${o.text}`)}>
                    열린 질문에 올리기
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {p.changeLog && (
          <section className="span-2">
            <h3>변경 로그</h3>
            <p className="small pre">{p.changeLog}</p>
          </section>
        )}
      </div>
    </details>
  );
}
