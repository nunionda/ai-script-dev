import { useEffect, useRef, useState } from 'react';
import { FileUp, Plus, Trash2 } from 'lucide-react';
import type { ProjectSummary, Proposal, Project, ScriptFormat } from '../../shared/types';
import { api, type ProjectPatch } from '../api';
import { Modal, go, projectPath, timeAgo, useAnnounce } from '../ui';
import { blankProject } from '../../shared/sample';
import { fromFountain } from '../../shared/fountain';
import { fromFdx } from '../../shared/fdx';
import { uid } from '../../shared/screenplay';
import { loadMe } from '../state';

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState<{ project: Project; proposals: Proposal[] } | null>(null);
  const announce = useAnnounce();
  const me = loadMe();

  const load = () =>
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!projects?.length) return setFocus(null);
    const id = projects[0].id;
    Promise.all([api.getProject(id), api.listProposals(id)])
      .then(([project, proposals]) => setFocus({ project, proposals: proposals.filter((p) => p.status === 'pending' || p.status === 'held') }))
      .catch(() => setFocus(null));
  }, [projects]);

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`"${p.title}"을(를) 삭제할까요? 작업본·수정안·의견도 함께 지워지며 되돌릴 수 없습니다.`)) return;
    await api.deleteProject(p.id);
    announce(`"${p.title}"을(를) 삭제했습니다.`);
    void load();
  };

  return (
    <div className="page home">
      <div className="heading">
        <div>
          <p className="eyebrow">YOUR STORIES, IN PROGRESS</p>
          <h1>다음 장면을 이어갈 시간.</h1>
          <p className="muted">작품과 대화, 함께 내린 결정을 한곳에서.</p>
        </div>
        <div className="row">
          {me.name && <span className="muted">{me.name} 작가의 작업실</span>}
          <button className="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />새 작품
          </button>
        </div>
      </div>

      {error && <p className="banner banner-warn">{error}</p>}
      {projects === null && !error && <p className="muted">불러오는 중…</p>}

      <div className="home-grid">
        <div className="project-list">
          {projects?.map((p, i) => (
            <article key={p.id} className={`project-card${i === 0 ? ' project-card-lead' : ''}`}>
              <button className="cover" onClick={() => go(projectPath(p.id))} aria-label={`${p.title} 열기`}>
                <span className="cover-genre">{p.genre || 'SCREENPLAY'}</span>
                <h2>{p.title}</h2>
                {p.logline && <p>{p.logline}</p>}
                <span className="cover-bottom">
                  {p.sceneCount}개 장면 · 약 {p.pageCount}쪽
                </span>
              </button>
              <div className="project-body">
                <div className="row">
                  <h2>{p.title}</h2>
                  {p.status && <span className="tag">{p.status}</span>}
                </div>
                <div className="row">
                  <span className="muted">마지막 수정 {timeAgo(p.updatedAt)}</span>
                  <div className="row tight">
                    <button className="icon-btn" onClick={() => void remove(p)} aria-label={`${p.title} 삭제`}>
                      <Trash2 aria-hidden="true" />
                    </button>
                    <button className="primary" onClick={() => go(projectPath(p.id))}>
                      이어서 집필 →
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
          {projects?.length === 0 && (
            <div className="empty-card">
              <h2>아직 작품이 없습니다</h2>
              <p className="muted">새 작품을 시작하거나 Final Draft(.fdx) · Fountain 파일을 가져오세요.</p>
              <button className="primary" onClick={() => setCreating(true)}>
                새 작품
              </button>
            </div>
          )}
        </div>

        {focus && (
          <aside className="home-side">
            <p className="eyebrow">DEVELOPMENT NOTES · {focus.project.title}</p>
            <h2>지금 이어갈 논의</h2>
            {focus.proposals.slice(0, 3).map((p) => (
              <button key={p.id} className="task" onClick={() => go(projectPath(focus.project.id, 'review', p.id))}>
                <span className="tag">{p.status === 'held' ? '보류한 수정안' : 'AI 수정안'}</span>
                <strong>{p.title || '장면 수정안'}</strong>
                <span>{p.rationale}</span>
                <span className="task-link">원문과 비교하기 →</span>
              </button>
            ))}
            <button className="task" onClick={() => go(projectPath(focus.project.id, 'board'))}>
              <span className="tag">스토리 구성</span>
              <strong>장면 보드</strong>
              <span>{focus.project.openQuestions[0] ?? '막과 장면의 순서를 카드로 정리합니다.'}</span>
              <span className="task-link">장면 보드 열기 →</span>
            </button>
            {focus.project.rulings.length > 0 && (
              <div className="decision">
                <p className="eyebrow">판정서</p>
                {focus.project.rulings.map((r) => (
                  <p key={r.id}>
                    <strong>{r.code}</strong> {r.text}
                  </p>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<ScriptFormat>('korean');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const create = async (data: ProjectPatch) => {
    setBusy(true);
    setError('');
    try {
      const p = await api.createProject(data);
      go(projectPath(p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '만들지 못했습니다.');
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const isFdx = /\.fdx$/i.test(file.name) || text.trimStart().startsWith('<?xml');
    let parsed;
    try {
      parsed = isFdx ? fromFdx(text) : fromFountain(text);
    } catch {
      setError('파일을 해석하지 못했습니다.');
      return;
    }
    if (!parsed.elements.length) {
      setError('가져올 원고 내용이 없습니다.');
      return;
    }
    const acts = parsed.acts.length ? parsed.acts : [{ id: uid('a'), title: '1막' }, { id: uid('a'), title: '2막' }, { id: uid('a'), title: '3막' }];
    const sceneMeta = { ...parsed.sceneMeta };
    const first = parsed.elements.find((e) => e.type === 'scene');
    if (first && !sceneMeta[first.id]?.act) sceneMeta[first.id] = { ...sceneMeta[first.id], act: acts[0].id };
    const hasHangul = parsed.elements.some((e) => /[가-힣]/.test(e.text));
    await create({
      title: parsed.title || title || file.name.replace(/\.[^.]+$/, ''),
      author: parsed.author,
      contact: parsed.contact,
      format: hasHangul ? 'korean' : 'hollywood',
      status: '가져온 원고',
      elements: parsed.elements,
      acts,
      sceneMeta,
    });
  };

  return (
    <Modal title="새 작품" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create({ ...blankProject(title.trim() || '제목 없음'), format });
        }}
      >
        <label>
          제목
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 마지막 상영" />
        </label>
        <fieldset>
          <legend>원고 서식</legend>
          <label className="radio">
            <input type="radio" checked={format === 'korean'} onChange={() => setFormat('korean')} />
            한국식 — S#1. 내부. 영사실 - 밤
          </label>
          <label className="radio">
            <input type="radio" checked={format === 'hollywood'} onChange={() => setFormat('hollywood')} />
            할리우드식 — 1 INT. PROJECTION BOOTH - NIGHT
          </label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            <FileUp aria-hidden="true" />
            파일 가져오기 (.fdx, .fountain)
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '만드는 중…' : '빈 원고로 시작'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".fdx,.fountain,.spmd,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </form>
    </Modal>
  );
}
