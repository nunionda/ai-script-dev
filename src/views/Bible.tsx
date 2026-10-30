import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { DocumentKind, Proposal, ReferenceDocument, Ruling, StructureAudit, StructureVerdict, TagCategory, TagKind } from '../../shared/types';
import { getScenes, lockSceneNumbers, uid, unlockSceneNumbers } from '../../shared/screenplay';
import { STAGE_LABEL, auditProject, counterStatus, motifLedger, needsEthicsReview } from '../../shared/audit';
import { api } from '../api';
import { useProject } from '../state';
import { go, projectPath, useAnnounce } from '../ui';

const DOC_KINDS: { kind: DocumentKind; label: string }[] = [
  { kind: 'synopsis', label: '시놉시스' },
  { kind: 'treatment', label: '트리트먼트' },
  { kind: 'scene-log', label: '씬 로그' },
  { kind: 'characters', label: '인물 설정서' },
  { kind: 'scene-bank', label: '장면 은행' },
  { kind: 'research', label: '취재 노트' },
  { kind: 'other', label: '기타' },
];

const TAG_KINDS: { kind: TagKind; label: string }[] = [
  { kind: 'motif', label: '모티프 (셋업·변주·회수)' },
  { kind: 'counter', label: '횟수 제한' },
  { kind: 'intimacy', label: '수위·재현 (라이더 대상)' },
  { kind: 'note', label: '메모' },
];

/** 작품 바이블: AI가 맨 앞에서 읽는 판정서·규칙·문서와, 코드가 판정하는 점검 */
export function Bible() {
  const { project, update } = useProject();
  const scenes = useMemo(() => getScenes(project), [project]);
  const findings = useMemo(() => auditProject(project), [project]);
  const counters = useMemo(() => counterStatus(project), [project]);
  const ledger = useMemo(() => motifLedger(project), [project]);
  const label = new Map(scenes.map((s) => [s.id, s.label]));
  const fails = findings.filter((f) => f.level === 'fail');
  const [banned, setBanned] = useState(project.bannedWords.join(', '));

  return (
    <div className="page bible">
      <div className="heading">
        <div>
          <p className="eyebrow">PROJECT BIBLE</p>
          <h1>판정서가 먼저, 판단은 그다음.</h1>
          <p className="muted">
            여기 적은 판정서·규칙·참고 문서는 AI가 매번 맨 앞에서 읽고 지킵니다. 횟수·짝·금지어는 코드가 직접 셉니다.
          </p>
        </div>
      </div>

      <div className="reports-grid">
        <section className="card span-2" aria-labelledby="audit-title">
          <h2 id="audit-title">
            점검 <span className="muted small">FAIL {fails.length} · 주의 {findings.length - fails.length}</span>
          </h2>
          {!findings.length && <p className="muted small">걸리는 항목이 없습니다.</p>}
          <ul className="plain-list findings">
            {findings.map((f, i) => (
              <li key={i} className={`finding finding-${f.level}`}>
                {f.level === 'fail' ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
                <span className="code">{f.code}</span>
                {f.sceneId ? (
                  <button className="link-btn" onClick={() => go(projectPath(project.id, 'write', f.elementId ?? f.sceneId))}>
                    {f.message}
                  </button>
                ) : (
                  <span>{f.message}</span>
                )}
              </li>
            ))}
          </ul>
          {(counters.length > 0 || ledger.length > 0) && (
            <div className="ledger-grid">
              {counters.length > 0 && (
                <div>
                  <h3>횟수</h3>
                  <ul className="plain-list">
                    {counters.map((c) => (
                      <li key={c.category.id} className={`counter counter-${c.state}`}>
                        {c.category.name} <strong>{c.count}</strong> / {c.category.exact ?? c.category.max}
                        {c.category.exact !== undefined ? ' (정확히)' : ' (최대)'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {ledger.length > 0 && (
                <div>
                  <h3>모티프 장부</h3>
                  <table className="table">
                    <tbody>
                      {ledger.map((row) => (
                        <tr key={row.category.id}>
                          <th scope="row">{row.category.name}</th>
                          <td>
                            {row.hits.length
                              ? row.hits.map((h) => `${h.sceneId ? `S#${label.get(h.sceneId)}` : '—'}${h.tag.stage ? ` ${STAGE_LABEL[h.tag.stage]}` : ''}`).join(' → ')
                              : <span className="muted">아직 없음</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>

        <StructureAuditCard />
        <ConsultantList />

        <section className="card form">
          <h2>하나의 행동</h2>
          <p className="muted small">주인공의 '하나의 행동'을 한 문장으로. 모든 장면이 이 행동의 부분인지 검사하는 기준입니다.</p>
          <textarea rows={3} value={project.oneAction} onChange={(e) => update({ oneAction: e.target.value })} aria-label="하나의 행동" />
          <h2>점검 규칙</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={project.auditOptions.banVoiceOver}
              onChange={(e) => update((p) => ({ auditOptions: { ...p.auditOptions, banVoiceOver: e.target.checked } }))}
            />
            V.O.·내레이션 금지
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.auditOptions.requireSceneCard}
              onChange={(e) => update((p) => ({ auditOptions: { ...p.auditOptions, requireSceneCard: e.target.checked } }))}
            />
            장면 카드 필수 (가치 전환·그래서/그러나 연결)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.numberingLocked}
              onChange={(e) =>
                update((p) =>
                  e.target.checked
                    ? { numberingLocked: true, sceneMeta: lockSceneNumbers(p) }
                    : { numberingLocked: false, sceneMeta: unlockSceneNumbers(p) },
                )
              }
            />
            장면 번호 고정 (추가 장면 41-1, 삭제 장면 번호 유지)
          </label>
          <label>
            금지어 (인물이 말하지 않는 주제어, 쉼표로 구분)
            <input
              value={banned}
              onChange={(e) => setBanned(e.target.value)}
              onBlur={() => update({ bannedWords: banned.split(',').map((w) => w.trim()).filter(Boolean) })}
              placeholder="예: 구원, 용서"
            />
          </label>
        </section>

        <RuleList
          title="판정서"
          note="AI가 어떤 이유로도 어기지 않는 최우선 규칙입니다. 요약하지 말고 전문을 적으세요."
          prefix="D"
          items={project.rulings}
          onChange={(rulings) => update({ rulings })}
        />
        <RuleList
          title="하드 규칙"
          note="작품 고유의 금지·필수 규칙 (예: 과거는 소리로만 3회 침입한다)."
          prefix="H"
          items={project.hardRules}
          onChange={(hardRules) => update({ hardRules })}
        />

        <TagCategories items={project.tagCategories} onChange={(tagCategories) => update({ tagCategories })} />

        <Documents projectId={project.id} />
      </div>
    </div>
  );
}

function RuleList({ title, note, prefix, items, onChange }: { title: string; note: string; prefix: string; items: Ruling[]; onChange: (items: Ruling[]) => void }) {
  const nextCode = () => {
    const nums = items.map((r) => Number(r.code.replace(/\D/g, ''))).filter((n) => Number.isFinite(n));
    return `${prefix}${(nums.length ? Math.max(...nums) : 0) + 1}`;
  };
  const set = (id: string, patch: Partial<Ruling>) => onChange(items.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted small">{note}</p>
      <ul className="plain-list">
        {items.map((r) => (
          <li key={r.id} className="row rule-row">
            <input className="code-input" value={r.code} onChange={(e) => set(r.id, { code: e.target.value })} aria-label={`${title} 번호`} />
            <textarea rows={2} value={r.text} onChange={(e) => set(r.id, { text: e.target.value })} aria-label={`${title} ${r.code}`} />
            <button className="icon-btn" aria-label={`${r.code} 삭제`} onClick={() => onChange(items.filter((x) => x.id !== r.id))}>
              <Trash2 aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <button onClick={() => onChange([...items, { id: uid(prefix.toLowerCase()), code: nextCode(), text: '' }])}>
        <Plus aria-hidden="true" />
        {title} 추가
      </button>
    </section>
  );
}

function TagCategories({ items, onChange }: { items: TagCategory[]; onChange: (items: TagCategory[]) => void }) {
  const set = (id: string, patch: Partial<TagCategory>) => onChange(items.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const limitKind = (c: TagCategory) => (c.exact !== undefined ? 'exact' : c.max !== undefined ? 'max' : 'none');
  return (
    <section className="card span-2">
      <h2>태그 분류</h2>
      <p className="muted small">집필 화면에서 요소에 태그를 붙이면 모티프 장부와 횟수가 자동으로 계산됩니다.</p>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">이름</th>
            <th scope="col">종류</th>
            <th scope="col">횟수 한도</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <input value={c.name} onChange={(e) => set(c.id, { name: e.target.value })} aria-label="분류 이름" />
              </td>
              <td>
                <select value={c.kind} onChange={(e) => set(c.id, { kind: e.target.value as TagKind })} aria-label="분류 종류">
                  {TAG_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="row tight">
                <select
                  value={limitKind(c)}
                  aria-label="한도 종류"
                  onChange={(e) => {
                    const n = c.exact ?? c.max ?? 1;
                    const v = e.target.value;
                    set(c.id, { exact: v === 'exact' ? n : undefined, max: v === 'max' ? n : undefined });
                  }}
                >
                  <option value="none">없음</option>
                  <option value="exact">정확히</option>
                  <option value="max">최대</option>
                </select>
                {limitKind(c) !== 'none' && (
                  <input
                    type="number"
                    min={0}
                    className="num-input"
                    value={c.exact ?? c.max ?? 0}
                    aria-label="횟수"
                    onChange={(e) => {
                      const n = Math.max(0, Number(e.target.value) || 0);
                      set(c.id, limitKind(c) === 'exact' ? { exact: n } : { max: n });
                    }}
                  />
                )}
                <span className="muted small">회</span>
              </td>
              <td>
                <button className="icon-btn" aria-label={`${c.name} 분류 삭제`} onClick={() => onChange(items.filter((x) => x.id !== c.id))}>
                  <Trash2 aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => onChange([...items, { id: uid('t'), name: '', kind: 'motif' }])}>
        <Plus aria-hidden="true" />
        분류 추가
      </button>
    </section>
  );
}

function Documents({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<ReferenceDocument[] | null>(null);
  const announce = useAnnounce();
  useEffect(() => {
    api.listDocuments(projectId).then(setDocs).catch(() => setDocs([]));
  }, [projectId]);

  const local = (id: string, patch: Partial<ReferenceDocument>) => setDocs((list) => list?.map((d) => (d.id === id ? { ...d, ...patch } : d)) ?? null);
  const save = async (d: ReferenceDocument) => {
    try {
      await api.updateDocument(d.id, { kind: d.kind, title: d.title, content: d.content });
    } catch (e) {
      announce(e instanceof Error ? e.message : '문서를 저장하지 못했습니다.');
    }
  };
  const add = async () => {
    const d = await api.createDocument(projectId, { kind: 'synopsis', title: '새 문서', content: '' });
    setDocs((list) => [...(list ?? []), d]);
  };
  const remove = async (d: ReferenceDocument) => {
    if (!confirm(`"${d.title}" 문서를 삭제할까요?`)) return;
    await api.deleteDocument(d.id);
    setDocs((list) => list?.filter((x) => x.id !== d.id) ?? null);
  };

  return (
    <section className="card span-2">
      <h2>참고 문서</h2>
      <p className="muted small">시놉시스·트리트먼트·씬 로그·인물 설정서·장면 은행·취재 노트의 전문을 붙여 넣으세요. 판정서 다음 순서로 AI에게 전달됩니다.</p>
      {docs === null && <p className="muted small">불러오는 중…</p>}
      {docs?.map((d) => (
        <article key={d.id} className="doc-item form">
          <div className="row tight">
            <select
              value={d.kind}
              aria-label="문서 종류"
              onChange={(e) => {
                const next = { ...d, kind: e.target.value as DocumentKind };
                local(d.id, next);
                void save(next);
              }}
            >
              {DOC_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <input value={d.title} aria-label="문서 제목" onChange={(e) => local(d.id, { title: e.target.value })} onBlur={() => void save(d)} />
            <span className="muted small nowrap">{d.content.length.toLocaleString()}자</span>
            <button className="icon-btn" aria-label={`${d.title} 삭제`} onClick={() => void remove(d)}>
              <Trash2 aria-hidden="true" />
            </button>
          </div>
          <textarea rows={8} value={d.content} aria-label={`${d.title} 내용`} onChange={(e) => local(d.id, { content: e.target.value })} onBlur={() => void save(d)} />
        </article>
      ))}
      <button onClick={() => void add()}>
        <Plus aria-hidden="true" />
        문서 추가
      </button>
    </section>
  );
}

const VERDICT_LABEL: Record<StructureVerdict, string> = { keep: '유지', revise: '고침', cut: '삭제 후보' };
const LINK_TEXT = { therefore: '그래서', but: '그러나', andthen: '그리고 나서' } as const;

/** 전체 씬 로그 인과 감사 (STRUCT). 결과는 작품별로 마지막 1개를 저장한다. */
function StructureAuditCard() {
  const { project, flush } = useProject();
  const [audit, setAudit] = useState<StructureAudit | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.getStructureAudit(project.id).then(setAudit).catch(() => setAudit(null));
  }, [project.id]);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      await flush();
      setAudit(await api.runStructureAudit(project.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '구조 감사를 하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const scenes = new Map(getScenes(project).map((s) => [s.id, s]));
  return (
    <section className="card span-2" aria-labelledby="structure-title">
      <div className="row">
        <h2 id="structure-title">씬 로그 인과 감사</h2>
        <button disabled={running} onClick={() => void run()}>
          {running ? '원고 전체를 읽는 중… (몇 분 걸릴 수 있어요)' : audit ? '다시 감사' : '감사 실행'}
        </button>
      </div>
      <p className="muted small">
        구조 검수자(STRUCT)가 원고 전체를 읽고 장면마다 연결어·가치 전환·하나의 행동과의 관계를 판정합니다. 원고는 바꾸지 않습니다. AI 호출 1회.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {audit && (
        <>
          <p>
            {audit.summary} <span className="muted small">({new Date(audit.createdAt).toLocaleString('ko-KR')})</span>
          </p>
          {audit.issues.length > 0 && (
            <ul className="small">
              {audit.issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">장면</th>
                  <th scope="col">연결</th>
                  <th scope="col">가치 전환</th>
                  <th scope="col">하나의 행동</th>
                  <th scope="col">판정</th>
                  <th scope="col">근거</th>
                </tr>
              </thead>
              <tbody>
                {audit.rows.map((r) => {
                  const s = scenes.get(r.sceneId);
                  return (
                    <tr key={r.sceneId}>
                      <th scope="row">
                        <button className="link-btn" onClick={() => go(projectPath(project.id, 'write', r.sceneId))}>
                          S#{s?.label ?? r.label}
                        </button>
                        <span className="muted small"> {s?.parts.location}</span>
                      </th>
                      <td className={r.link === 'andthen' ? 'fail-text' : undefined}>{LINK_TEXT[r.link]}</td>
                      <td className={r.valueShift ? undefined : 'fail-text'}>{r.valueShift ? '있음' : '없음'}</td>
                      <td className={r.onAction ? undefined : 'fail-text'}>{r.onAction ? '부분' : '아님'}</td>
                      <td>
                        <span className={`tag${r.verdict === 'cut' ? ' tag-fail' : r.verdict === 'revise' ? ' tag-warn' : ''}`}>{VERDICT_LABEL[r.verdict]}</span>
                      </td>
                      <td className="small">{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** 컨설턴트 검토 목록: 수위·재현 장면의 확인 상태와 검수자가 모은 질문 */
function ConsultantList() {
  const { project } = useProject();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  useEffect(() => {
    api.listProposals(project.id).then(setProposals).catch(() => undefined);
  }, [project.id]);
  const scenes = getScenes(project);
  const label = new Map(scenes.map((s) => [s.id, s.label]));
  const needed = scenes.filter((s) => !s.meta.omitted && (needsEthicsReview(project, s.id) || s.meta.signoff));
  const questions = proposals.flatMap((p) =>
    p.status === 'rejected' ? [] : p.reviews.flatMap((r) => r.consultantItems.map((text) => ({ sceneId: p.sceneId, role: r.role, text, proposal: p.id }))),
  );
  if (!needed.length && !questions.length) return null;
  return (
    <section className="card span-2" aria-labelledby="consultant-title">
      <h2 id="consultant-title">컨설턴트 검토 목록</h2>
      <p className="muted small">수위·재현 태그나 수위 메모가 있는 장면, 그리고 역할 검수에서 나온 확인 질문입니다. 확인 기록은 보드의 장면 카드에서 남깁니다.</p>
      {needed.length > 0 && (
        <ul className="plain-list findings">
          {needed.map((s) => (
            <li key={s.id} className={`finding ${s.meta.signoff ? 'finding-pass' : 'finding-warn'}`}>
              {s.meta.signoff ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
              <button className="link-btn" onClick={() => go(projectPath(project.id, 'board'))}>
                S#{s.label} {s.parts.location}
              </button>
              <span className="small">
                {s.meta.signoff
                  ? `${s.meta.signoff.by} · ${new Date(s.meta.signoff.at).toLocaleDateString('ko-KR')} 확인${s.meta.signoff.note ? ` — ${s.meta.signoff.note}` : ''}`
                  : '확인 필요'}
                {s.meta.ratingNote && ` · 수위 메모: ${s.meta.ratingNote}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {questions.length > 0 && (
        <>
          <h3>검수자가 모은 질문</h3>
          <ul className="plain-list">
            {questions.map((q, i) => (
              <li key={i} className="small">
                <button className="link-btn" onClick={() => go(projectPath(project.id, 'review', q.proposal))}>
                  S#{label.get(q.sceneId) ?? '?'} · {q.role}
                </button>{' '}
                {q.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
