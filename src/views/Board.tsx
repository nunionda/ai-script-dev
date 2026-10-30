import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, NotebookPen, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { Act, Project, Proposal, SceneLink, SceneMeta, TurnBy } from '../../shared/types';
import { auditProject } from '../../shared/audit';
import { el, getScenes, reorderScenes, uid, type SceneInfo } from '../../shared/screenplay';
import { formatEighths, paginate } from '../../shared/pagination';
import { api } from '../api';
import { useProject } from '../state';
import { go, projectPath, useAnnounce } from '../ui';

type Layout = { actId: string; sceneIds: string[] }[];

/** 막 배치를 원고 순서와 장면 정보에 반영. 모든 장면의 막을 명시해 이후 편집에도 흔들리지 않게 한다. */
function layoutPatch(p: Pick<Project, 'elements' | 'sceneMeta'>, layout: Layout) {
  const sceneMeta = { ...p.sceneMeta };
  for (const col of layout) for (const id of col.sceneIds) sceneMeta[id] = { ...sceneMeta[id], act: col.actId || undefined };
  return { elements: reorderScenes(p.elements, layout.flatMap((c) => c.sceneIds)), sceneMeta };
}

interface Column {
  act: Act;
  scenes: SceneInfo[];
}

export function Board() {
  const { project, update } = useProject();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const announce = useAnnounce();

  useEffect(() => {
    api.listProposals(project.id).then(setProposals).catch(() => undefined);
  }, [project.id]);

  const scenes = useMemo(() => getScenes(project), [project]);
  const eighths = useMemo(() => paginate(project.elements).sceneEighths, [project.elements]);
  const columns: Column[] = useMemo(() => {
    const acts = project.acts.length ? project.acts : [{ id: '', title: '1막' }];
    const cols = acts.map((act) => ({ act, scenes: [] as SceneInfo[] }));
    for (const s of scenes) (cols.find((c) => c.act.id === s.actId) ?? cols[0]).scenes.push(s);
    return cols;
  }, [scenes, project.acts]);

  const pendingByScene = useMemo(() => new Set(proposals.filter((p) => p.status === 'pending' || p.status === 'held').map((p) => p.sceneId)), [proposals]);

  const applyLayout = (layout: Layout) => update((p) => layoutPatch(p, layout));

  const layoutOf = () => columns.map((c) => ({ actId: c.act.id, sceneIds: c.scenes.map((s) => s.id) }));

  const moveScene = (sceneId: string, toActId: string, beforeSceneId: string | null) => {
    const layout = layoutOf().map((c) => ({ ...c, sceneIds: c.sceneIds.filter((id) => id !== sceneId) }));
    const col = layout.find((c) => c.actId === toActId) ?? layout[0];
    const at = beforeSceneId ? col.sceneIds.indexOf(beforeSceneId) : -1;
    if (at >= 0) col.sceneIds.splice(at, 0, sceneId);
    else col.sceneIds.push(sceneId);
    applyLayout(layout);
  };

  const nudge = (scene: SceneInfo, dir: -1 | 1) => {
    const flat = columns.flatMap((c) => c.scenes.map((s) => ({ s, act: c.act.id })));
    const i = flat.findIndex((x) => x.s.id === scene.id);
    const j = i + dir;
    if (j < 0 || j >= flat.length) return;
    const target = flat[j];
    if (target.act !== flat[i].act) moveScene(scene.id, target.act, dir === -1 ? null : columns.find((c) => c.act.id === target.act)!.scenes[0]?.id ?? null);
    else moveScene(scene.id, target.act, dir === -1 ? target.s.id : flat[j + 1]?.act === target.act ? flat[j + 1].s.id : null);
  };

  const findings = useMemo(() => auditProject(project), [project]);
  const failsByScene = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of findings) if (f.level === 'fail' && f.sceneId) m.set(f.sceneId, [...(m.get(f.sceneId) ?? []), f.message]);
    return m;
  }, [findings]);
  const issueScenes = useMemo(() => new Set(findings.map((f) => f.sceneId).filter(Boolean)), [findings]);
  const [onlyIssues, setOnlyIssues] = useState(false);

  const setMeta = (sceneId: string, patch: Partial<SceneMeta>) =>
    update((p) => ({ sceneMeta: { ...p.sceneMeta, [sceneId]: { ...p.sceneMeta[sceneId], ...patch } } }));

  const addScene = (col: Column) => {
    const heading = el('scene', project.format === 'korean' ? '내부. 새 장소 - 낮' : 'INT. NEW LOCATION - DAY');
    const body = el('action', '');
    const layout = layoutOf().map((c) => (c.actId === col.act.id ? { ...c, sceneIds: [...c.sceneIds, heading.id] } : c));
    update((p) => layoutPatch({ ...p, elements: [...p.elements, heading, body] }, layout));
    setEditing(heading.id);
    announce('새 장면 카드를 만들었습니다. 원고에서 씬 헤딩을 고칠 수 있습니다.');
  };

  const addAct = () => {
    const act = { id: uid('a'), title: `${project.acts.length + 1}막` };
    update((p) => ({ acts: [...p.acts, act] }));
  };

  const renameAct = (id: string, title: string) => update((p) => ({ acts: p.acts.map((a) => (a.id === id ? { ...a, title } : a)) }));

  const removeAct = (col: Column) => {
    if (project.acts.length <= 1) return;
    if (col.scenes.length && !confirm(`"${col.act.title}"의 장면 ${col.scenes.length}개는 앞 막으로 옮겨집니다. 막을 삭제할까요?`)) return;
    const idx = project.acts.findIndex((a) => a.id === col.act.id);
    const target = project.acts[idx - 1] ?? project.acts[idx + 1];
    const layout = layoutOf()
      .map((c) => (c.actId === target.id ? { ...c, sceneIds: idx > 0 ? [...c.sceneIds, ...col.scenes.map((s) => s.id)] : [...col.scenes.map((s) => s.id), ...c.sceneIds] } : c))
      .filter((c) => c.actId !== col.act.id);
    applyLayout(layout);
    update((p) => ({ acts: p.acts.filter((a) => a.id !== col.act.id) }));
  };

  const generateCard = async (s: SceneInfo) => {
    setAiBusy(s.id);
    try {
      const card = await api.sceneCard(project.id, s.id);
      // 요약은 새로 받고, 작가가 이미 적은 카드 항목은 그대로 둔다
      const filled: Partial<SceneMeta> = { synopsis: card.synopsis };
      for (const k of ['intent', 'pov', 'goal', 'obstacle', 'outcome', 'valueStart', 'valueEnd', 'turnBy', 'link'] as const) {
        if (!String(s.meta[k] ?? '').trim()) (filled as Record<string, unknown>)[k] = card[k];
      }
      setMeta(s.id, filled);
      announce(`S#${s.label} 장면 카드를 AI 요약으로 채웠습니다.`);
    } catch (e) {
      announce(e instanceof Error ? e.message : 'AI 요약을 만들지 못했습니다.');
    } finally {
      setAiBusy(null);
    }
  };

  return (
    <div className="page board">
      <div className="heading">
        <div>
          <p className="eyebrow">STORY STRUCTURE</p>
          <h1>장면 사이에서 이야기를 발견하다.</h1>
          <p className="muted">
            {project.title} · {scenes.length}개 장면 · 카드를 끌어 순서와 막을 바꾸면 원고에도 반영됩니다
          </p>
        </div>
        <div className="row tight">
          <label className="check">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            점검 걸린 장면만
          </label>
          <button onClick={() => go(projectPath(project.id, 'write'))}>원고로 돌아가기 →</button>
        </div>
      </div>

      <div className="board-grid" style={{ gridTemplateColumns: `repeat(${columns.length + 1}, minmax(240px, 1fr))` }}>
        {columns.map((col, ci) => (
          <section
            key={col.act.id || 'default'}
            className={`board-col${dropTarget === `col:${col.act.id}` ? ' drop' : ''}`}
            aria-label={col.act.title}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              if (dropTarget?.startsWith('card:')) return;
              setDropTarget(`col:${col.act.id}`);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) moveScene(dragId, col.act.id, null);
              setDragId(null);
              setDropTarget(null);
            }}
          >
            <div className="col-head">
              <span className="col-no">{String(ci + 1).padStart(2, '0')}</span>
              <input className="act-title" value={col.act.title} aria-label="막 제목" onChange={(e) => renameAct(col.act.id, e.target.value)} />
              {project.acts.length > 1 && (
                <button className="icon-btn" onClick={() => removeAct(col)} aria-label={`${col.act.title} 막 삭제`}>
                  <Trash2 aria-hidden="true" />
                </button>
              )}
            </div>
            {col.scenes.filter((s) => !onlyIssues || issueScenes.has(s.id)).map((s) => (
              <article
                key={s.id}
                className={`beat${pendingByScene.has(s.id) ? ' beat-active' : ''}${dragId === s.id ? ' dragging' : ''}${dropTarget === `card:${s.id}` ? ' drop-before' : ''}`}
                draggable={editing !== s.id}
                onDragStart={(e) => {
                  setDragId(s.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', s.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTarget(null);
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === s.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(`card:${s.id}`);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragId && dragId !== s.id) moveScene(dragId, col.act.id, s.id);
                  setDragId(null);
                  setDropTarget(null);
                }}
              >
                <span className="eyebrow">
                  {project.format === 'korean' ? 'S#' : 'SCENE '}
                  {s.label} · {[s.parts.place, s.parts.time].filter(Boolean).join(' / ') || '헤딩 미정'} · {formatEighths(eighths.get(s.id) ?? 1)}쪽
                </span>
                <h3>{s.parts.location || s.heading || '(제목 없는 장면)'}</h3>
                {editing === s.id ? (
                  <div className="form">
                    <label>
                      장면 요약
                      <textarea rows={3} value={s.meta.synopsis ?? ''} onChange={(e) => setMeta(s.id, { synopsis: e.target.value })} autoFocus />
                    </label>
                    <label>
                      장면의 의도
                      <textarea rows={2} value={s.meta.intent ?? ''} onChange={(e) => setMeta(s.id, { intent: e.target.value })} />
                    </label>
                    <CardFields meta={s.meta} onChange={(patch) => setMeta(s.id, patch)} />
                    <label className="check">
                      <input type="checkbox" checked={Boolean(s.meta.omitted)} onChange={(e) => setMeta(s.id, { omitted: e.target.checked || undefined })} />
                      삭제 장면 (번호 유지)
                    </label>
                    <div className="row tight">
                      <button className="icon-btn" onClick={() => nudge(s, -1)} aria-label="앞으로 옮기기">
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button className="icon-btn" onClick={() => nudge(s, 1)} aria-label="뒤로 옮기기">
                        <ArrowDown aria-hidden="true" />
                      </button>
                      <button className="primary" onClick={() => setEditing(null)}>
                        완료
                      </button>
                    </div>
                  </div>
                ) : (
                  <p onDoubleClick={() => setEditing(s.id)}>{s.meta.synopsis || <span className="muted">요약이 없습니다. 편집을 눌러 쓰거나 AI 요약을 받아 보세요.</span>}</p>
                )}
                {s.characters.length > 0 && editing !== s.id && <p className="beat-cast">{s.characters.join(' · ')}</p>}
                {editing !== s.id && <CardSummary meta={s.meta} fails={failsByScene.get(s.id) ?? []} />}
                {editing !== s.id && (
                  <div className="row">
                    <div className="row tight">
                      {pendingByScene.has(s.id) && <span className="tag">수정 논의 중</span>}
                      <button className="small-btn" onClick={() => setEditing(s.id)}>
                        편집
                      </button>
                      <button className="small-btn" onClick={() => void generateCard(s)} disabled={aiBusy === s.id} title="AI가 장면 요약과 의도를 씁니다">
                        <Sparkles aria-hidden="true" />
                        {aiBusy === s.id ? '요약 중…' : 'AI 요약'}
                      </button>
                    </div>
                    <button className="small-btn" onClick={() => go(projectPath(project.id, 'write', s.id))}>
                      장면 읽기 →
                    </button>
                  </div>
                )}
              </article>
            ))}
            <button className="add-card" onClick={() => addScene(col)}>
              <Plus aria-hidden="true" />
              장면 카드 추가
            </button>
          </section>
        ))}
        <section className="board-col board-side">
          <button className="add-card" onClick={addAct}>
            <Plus aria-hidden="true" />막 추가
          </button>
          <OpenQuestions />
        </section>
      </div>
    </div>
  );
}

function OpenQuestions() {
  const { project, update } = useProject();
  const [draft, setDraft] = useState('');
  return (
    <div className="open-question">
      <NotebookPen aria-hidden="true" />
      <h3>아직 열어 둔 질문</h3>
      {project.openQuestions.map((q, i) => (
        <div key={i} className="question">
          <p>{q}</p>
          <button
            className="icon-btn"
            aria-label="질문 삭제"
            onClick={() => update((p) => ({ openQuestions: p.openQuestions.filter((_, j) => j !== i) }))}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      ))}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          update((p) => ({ openQuestions: [...p.openQuestions, draft.trim()] }));
          setDraft('');
        }}
      >
        <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="예: 결말에서 서윤은 남는가?" aria-label="새 질문" />
        <button type="submit" disabled={!draft.trim()}>
          질문 남기기
        </button>
      </form>
      <span className="muted small">작가의 개발 메모 · AI 개발 파트너도 참고합니다</span>
    </div>
  );
}

const LINKS: { value: SceneLink; label: string }[] = [
  { value: 'therefore', label: '그래서' },
  { value: 'but', label: '그러나' },
  { value: 'andthen', label: '그리고 나서' },
];

/** 장면 카드: 쓰기 전에 선언하는 목표·장애·결과·가치 전환·연결어 */
function CardFields({ meta, onChange }: { meta: SceneMeta; onChange: (patch: Partial<SceneMeta>) => void }) {
  const text = (key: 'pov' | 'goal' | 'obstacle' | 'outcome' | 'valueStart' | 'valueEnd' | 'ratingNote', label: string, placeholder = '') => (
    <label>
      {label}
      <input value={meta[key] ?? ''} placeholder={placeholder} onChange={(e) => onChange({ [key]: e.target.value })} />
    </label>
  );
  return (
    <fieldset className="card-fields">
      <legend>장면 카드</legend>
      {text('pov', '시점 인물')}
      {text('goal', '목표', '누가 무엇을 원하는가')}
      {text('obstacle', '장애')}
      {text('outcome', '결과')}
      <div className="row tight">
        {text('valueStart', '시작 가치', '신뢰 +')}
        {text('valueEnd', '끝 가치', '불신 −')}
      </div>
      <div className="row tight">
        <label>
          전환 수단
          <select value={meta.turnBy ?? ''} onChange={(e) => onChange({ turnBy: (e.target.value || undefined) as TurnBy | undefined })}>
            <option value="">—</option>
            <option value="action">행동</option>
            <option value="revelation">폭로</option>
          </select>
        </label>
        <label>
          직전 장면과
          <select value={meta.link ?? ''} onChange={(e) => onChange({ link: (e.target.value || undefined) as SceneLink | undefined })}>
            <option value="">—</option>
            {LINKS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {text('ratingNote', '수위·재현 메모', '노출 정도, 시뮬레이션 범위, 카메라 원칙')}
    </fieldset>
  );
}

function CardSummary({ meta, fails }: { meta: SceneMeta; fails: string[] }) {
  const link = LINKS.find((l) => l.value === meta.link)?.label;
  if (!link && !meta.valueStart && !meta.valueEnd && !fails.length && !meta.omitted) return null;
  return (
    <p className="card-summary">
      {meta.omitted && <span className="tag">삭제</span>}
      {link && <span className={`tag${meta.link === 'andthen' ? ' tag-fail' : ''}`}>{link}</span>}
      {(meta.valueStart || meta.valueEnd) && (
        <span className="muted small">
          {meta.valueStart || '?'} → {meta.valueEnd || '?'}
        </span>
      )}
      {fails.length > 0 && (
        <span className="tag tag-fail" title={fails.join(' / ')}>
          점검 FAIL {fails.length}
        </span>
      )}
    </p>
  );
}
