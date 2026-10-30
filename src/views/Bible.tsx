import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { DocumentKind, ReferenceDocument, Ruling, TagCategory, TagKind } from '../../shared/types';
import { getScenes, lockSceneNumbers, uid, unlockSceneNumbers } from '../../shared/screenplay';
import { STAGE_LABEL, auditProject, counterStatus, motifLedger } from '../../shared/audit';
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
