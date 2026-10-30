import { useCallback, useEffect, useMemo, useState } from 'react';
import { Languages, Plus, RefreshCw } from 'lucide-react';
import type { Project, ProjectSummary } from '../../shared/types';
import { sceneElements } from '../../shared/screenplay';
import { placeTranslatedScene, sceneHash, syncStatus, type SceneSyncState } from '../../shared/translation';
import { api, type SceneTranslation } from '../api';
import { useProject } from '../state';
import { go, projectPath, timeAgo, useAnnounce } from '../ui';

const STATE_LABEL: Record<SceneSyncState, string> = {
  untranslated: '미번역',
  current: '최신',
  stale: '갱신 필요',
  missing: '병행본에서 지워짐',
  omitted: '정본에서 삭제',
};

/** 영문 병행본: 정본이면 연결된 병행본 목록, 병행본이면 장면별 번역 현황 */
export function Parallel() {
  const { project } = useProject();
  return project.translation ? <TranslationStatus /> : <SourceView />;
}

function SourceView() {
  const { project, flush } = useProject();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.listTranslations(project.id).then(setList).catch(() => setList([]));
  }, [project.id]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await flush();
      const p = await api.createTranslation(project.id);
      go(projectPath(p.id, 'parallel'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '병행본을 만들지 못했습니다.');
      setBusy(false);
    }
  };

  return (
    <div className="page parallel">
      <div className="heading">
        <div>
          <p className="eyebrow">PARALLEL VERSION</p>
          <h1>정본은 하나, 번역은 그 그림자.</h1>
          <p className="muted">
            이 작품을 한국어 정본으로 두고 영문 병행본(할리우드 서식)을 만듭니다. 판정서·규칙·태그 분류는 함께 가져가고, 원고는 장면별로 번역합니다. 병행본에서 고친 내용은 정본에
            반영되지 않습니다.
          </p>
        </div>
        <button className="primary" disabled={busy} onClick={() => void create()}>
          <Plus aria-hidden="true" />
          {busy ? '만드는 중…' : '영문 병행본 만들기'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="card">
        <h2>연결된 병행본</h2>
        {list === null && <p className="muted small">불러오는 중…</p>}
        {list?.length === 0 && <p className="muted small">아직 없습니다.</p>}
        <ul className="plain-list">
          {list?.map((p) => (
            <li key={p.id} className="row">
              <button className="link-btn" onClick={() => go(projectPath(p.id, 'parallel'))}>
                <Languages aria-hidden="true" /> {p.title}
              </button>
              <span className="muted small">
                장면 {p.sceneCount} · {timeAgo(p.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TranslationStatus() {
  const { project, update } = useProject();
  const link = project.translation!;
  const [source, setSource] = useState<Project | null | undefined>(undefined);
  const [running, setRunning] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  /** 일괄 번역 진행: 끝난 장면 수 / 전체 */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const announce = useAnnounce();

  const load = useCallback(() => {
    api.getProject(link.sourceProjectId).then(setSource).catch(() => setSource(null));
  }, [link.sourceProjectId]);
  useEffect(load, [load]);

  const rows = useMemo(() => (source ? syncStatus(source, project, link) : []), [source, project, link]);

  const apply = useCallback(
    (src: Project, sourceSceneId: string, t: SceneTranslation) => {
      update((p) => {
        const cur = p.translation!;
        const placed = placeTranslatedScene(p.elements, cur, src, sourceSceneId, t.elements);
        const translated = sceneElements(placed.elements, placed.targetSceneId);
        return {
          elements: placed.elements,
          sceneMeta: { ...p.sceneMeta, [placed.targetSceneId]: { ...p.sceneMeta[placed.targetSceneId], label: t.label, act: t.act || undefined } },
          translation: {
            ...cur,
            // 작가가 고친 표기가 이긴다
            names: { ...t.names, ...cur.names },
            scenes: {
              ...cur.scenes,
              [sourceSceneId]: {
                targetSceneId: placed.targetSceneId,
                sourceHash: t.sourceHash,
                targetHash: sceneHash(translated),
                translatedAt: new Date().toISOString(),
                losses: t.losses,
              },
            },
          },
        };
      });
    },
    [update],
  );

  const translate = useCallback(
    async (sourceSceneId: string) => {
      if (!source) return false;
      setRunning(sourceSceneId);
      setError('');
      try {
        const fresh = await api.getProject(source.id);
        setSource(fresh);
        const t = await api.translateScene(project.id, sourceSceneId, link.names);
        apply(fresh, sourceSceneId, t);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '번역하지 못했습니다.');
        return false;
      } finally {
        setRunning(null);
      }
    },
    [source, project.id, link.names, apply],
  );

  // 일괄 번역: 한 장면씩 차례로
  useEffect(() => {
    if (!queue.length || running) return;
    const [next, ...rest] = queue;
    // 번역을 시작하기 전에 꺼내 둔다 — 끝난 직후 같은 장면을 다시 집지 않도록
    setQueue(rest);
    void translate(next).then((ok) => {
      if (!ok) {
        setQueue([]);
        setBatch(null);
      } else if (!rest.length) {
        setBatch(null);
        announce('일괄 번역을 마쳤습니다.');
      } else setBatch((b) => b && { ...b, done: b.done + 1 });
    });
  }, [queue, running, translate, announce]);

  const editedSince = (sourceSceneId: string) => {
    const t = link.scenes[sourceSceneId];
    return Boolean(t && project.elements.some((e) => e.id === t.targetSceneId) && sceneHash(sceneElements(project.elements, t.targetSceneId)) !== t.targetHash);
  };

  const ask = (sourceSceneId: string) => {
    if (editedSince(sourceSceneId) && !confirm('번역한 뒤 병행본에서 이 장면을 고쳤습니다. 다시 번역하면 그 수정이 사라집니다. 계속할까요?')) return;
    void translate(sourceSceneId);
  };

  if (source === undefined) return <div className="page muted">불러오는 중…</div>;
  if (source === null)
    return (
      <div className="page">
        <p className="error">연결된 한국어 정본을 찾을 수 없습니다. 정본이 삭제되었을 수 있습니다.</p>
      </div>
    );

  const pending = rows.filter((r) => r.state === 'untranslated' || r.state === 'stale').map((r) => r.sourceSceneId);
  const count = (s: SceneSyncState) => rows.filter((r) => r.state === s).length;

  return (
    <div className="page parallel">
      <div className="heading">
        <div>
          <p className="eyebrow">PARALLEL VERSION · ENGLISH</p>
          <h1>{project.title}</h1>
          <p className="muted">
            정본:{' '}
            <button className="link-btn" onClick={() => go(projectPath(source.id, 'write'))}>
              {source.title}
            </button>{' '}
            · 최신 {count('current')} · 갱신 필요 {count('stale')} · 미번역 {count('untranslated')}
          </p>
        </div>
        <div className="row tight">
          <button onClick={load} aria-label="정본 다시 불러오기">
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            className="primary"
            disabled={!pending.length || running !== null || batch !== null}
            onClick={() => {
              if (pending.some(editedSince) && !confirm('갱신할 장면 가운데 병행본에서 고친 장면이 있습니다. 다시 번역하면 그 수정이 사라집니다. 계속할까요?')) return;
              setBatch({ done: 0, total: pending.length });
              setQueue(pending);
            }}
          >
            {batch ? `번역 중… ${batch.done + 1}/${batch.total}` : `미번역·갱신 필요 ${pending.length}장면 번역`}
          </button>
        </div>
      </div>
      <p className="muted small">장면 번역 1회 = AI 호출 1회. 번역은 STRAT 역할이 정본의 판정서·참고 문서를 읽고 하며, 잃은 것은 손실표로 남깁니다.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">정본 장면</th>
                <th scope="col">상태</th>
                <th scope="col">손실</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = link.scenes[r.sourceSceneId];
                return (
                  <tr key={r.sourceSceneId}>
                    <th scope="row">
                      S#{r.label} <span className="muted small">{r.heading}</span>
                    </th>
                    <td>
                      <span className={`tag${r.state === 'stale' || r.state === 'missing' ? ' tag-warn' : r.state === 'current' ? '' : ' tag-muted'}`}>{STATE_LABEL[r.state]}</span>
                      {r.state !== 'untranslated' && editedSince(r.sourceSceneId) && <span className="muted small"> · 영문 수정됨</span>}
                    </td>
                    <td>
                      {t?.losses.length ? (
                        <button className="link-btn" aria-expanded={open === r.sourceSceneId} onClick={() => setOpen(open === r.sourceSceneId ? null : r.sourceSceneId)}>
                          {t.losses.length}건
                        </button>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="row tight">
                      {r.state !== 'omitted' && (
                        <button className="small-btn" disabled={running !== null || batch !== null} onClick={() => ask(r.sourceSceneId)}>
                          {running === r.sourceSceneId ? '번역 중…' : r.state === 'untranslated' || r.state === 'missing' ? '번역' : '다시 번역'}
                        </button>
                      )}
                      {r.state !== 'untranslated' && r.state !== 'missing' && t && (
                        <button className="small-btn" onClick={() => go(projectPath(project.id, 'write', t.targetSceneId))}>
                          영문 보기
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {open && link.scenes[open] && (
          <div className="losses">
            <h3>번역 손실표 — S#{rows.find((r) => r.sourceSceneId === open)?.label}</h3>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">원문</th>
                  <th scope="col">번역</th>
                  <th scope="col">잃은 것</th>
                  <th scope="col">보완</th>
                </tr>
              </thead>
              <tbody>
                {link.scenes[open].losses.map((l, i) => (
                  <tr key={i}>
                    <td>{l.original}</td>
                    <td>{l.translation}</td>
                    <td>{l.loss}</td>
                    <td>{l.compensation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Names />
    </div>
  );
}

/** 인물·장소 이름 표기. 다음 번역부터 이 표기를 쓴다. */
function Names() {
  const { project, update } = useProject();
  const names = project.translation!.names;
  const set = (next: Record<string, string>) => update((p) => ({ translation: { ...p.translation!, names: next } }));
  const [ko, setKo] = useState('');
  const [en, setEn] = useState('');
  return (
    <section className="card form">
      <h2>이름 표기</h2>
      <p className="muted small">번역할 때마다 이 표기를 그대로 씁니다. 처음 나온 이름은 AI가 정해 여기에 더합니다. 이미 번역한 장면의 이름은 바뀌지 않습니다.</p>
      <table className="table">
        <tbody>
          {Object.entries(names).map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>
                <input value={v} aria-label={`${k} 영문 표기`} onChange={(e) => set({ ...names, [k]: e.target.value })} />
              </td>
              <td>
                <button
                  className="small-btn"
                  onClick={() => {
                    const { [k]: _gone, ...rest } = names;
                    set(rest);
                  }}
                >
                  빼기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row tight">
        <input value={ko} onChange={(e) => setKo(e.target.value)} placeholder="한국어 (예: 세영)" aria-label="한국어 이름" />
        <input value={en} onChange={(e) => setEn(e.target.value)} placeholder="영문 (예: SEYOUNG)" aria-label="영문 표기" />
        <button
          disabled={!ko.trim() || !en.trim()}
          onClick={() => {
            set({ ...names, [ko.trim()]: en.trim() });
            setKo('');
            setEn('');
          }}
        >
          <Plus aria-hidden="true" />
          추가
        </button>
      </div>
    </section>
  );
}
