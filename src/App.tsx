import { useEffect, useState } from 'react';
import { FileClock, FilePenLine, GitCompareArrows, LayoutGrid, PanelsTopLeft, ChartColumn, Languages, ScrollText } from 'lucide-react';
import type { Project } from '../shared/types';
import { api } from './api';
import { ProjectProvider, useProject, type SaveState } from './state';
import { StatusProvider, go, projectPath, useRoute, type View } from './ui';
import { Home } from './views/Home';
import { Writer } from './views/Writer';
import { Board } from './views/Board';
import { Review } from './views/Review';
import { Drafts } from './views/Drafts';
import { Reports } from './views/Reports';
import { Bible } from './views/Bible';
import { Parallel } from './views/Parallel';
import { PrintView } from './views/PrintView';
import { AccountMenu } from './Auth';

const NAV: { view: View; label: string; icon: typeof LayoutGrid }[] = [
  { view: 'board', label: '스토리 구성', icon: PanelsTopLeft },
  { view: 'write', label: '집필', icon: FilePenLine },
  { view: 'review', label: '수정안 검토', icon: GitCompareArrows },
  { view: 'drafts', label: '작업본', icon: FileClock },
  { view: 'bible', label: '작품 바이블', icon: ScrollText },
  { view: 'parallel', label: '영문 병행본', icon: Languages },
  { view: 'reports', label: '리포트 · 설정', icon: ChartColumn },
];

export function App() {
  const route = useRoute();
  if (route.projectId && route.view === 'print') return <ProjectLoader id={route.projectId} print />;
  return (
    <StatusProvider>
      {(status) => (
        <div className="app">
          {route.projectId ? (
            <ProjectLoader id={route.projectId} status={status} />
          ) : (
            <>
              <Header />
              <nav className="nav" aria-label="작업 화면">
                <button aria-current="page">
                  <LayoutGrid aria-hidden="true" />
                  프로젝트
                </button>
              </nav>
              <main className="screen">
                <Home />
              </main>
              <Footer status={status} />
            </>
          )}
        </div>
      )}
    </StatusProvider>
  );
}

function Header({ title, save }: { title?: string; save?: SaveState }) {
  return (
    <header className="header">
      <button className="brand" onClick={() => go('#/')} aria-label="프로젝트 홈">
        FRAME<span>WRITERS’ ROOM</span>
      </button>
      <div className="breadcrumb">
        작업실{title && (
          <>
            <span>/</span>
            {title}
          </>
        )}
      </div>
      {save && <SaveIndicator state={save} />}
      <AccountMenu />
    </header>
  );
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '저장됨',
  dirty: '변경 사항 있음',
  saving: '저장 중…',
  error: '저장 실패 · 다시 시도 중',
  conflict: '다른 곳에서 수정됨',
};

function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className={`save-state save-${state}`} role="status">
      <span className="save-dot" aria-hidden="true" />
      {SAVE_LABEL[state]}
    </span>
  );
}

function Footer({ status }: { status: string }) {
  return (
    <footer className="footer">
      <span>FRAME — 시나리오 개발 작업실</span>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </footer>
  );
}

function ProjectLoader({ id, status = '', print }: { id: string; status?: string; print?: boolean }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setProject(null);
    setError('');
    api
      .getProject(id)
      .then((p) => alive && setProject(p))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error)
    return (
      <>
        <Header />
        <main className="screen empty-state">
          <h1>작품을 열 수 없습니다</h1>
          <p className="muted">{error}</p>
          <button className="primary" onClick={() => go('#/')}>
            프로젝트 목록으로
          </button>
        </main>
      </>
    );
  if (!project)
    return (
      <div className="loading" role="status">
        작품을 여는 중…
      </div>
    );
  return (
    <ProjectProvider key={project.id} initial={project}>
      {print ? <PrintView /> : <ProjectShell status={status} />}
    </ProjectProvider>
  );
}

function ProjectShell({ status }: { status: string }) {
  const { project, saveState, saveError, resolveConflict } = useProject();
  const route = useRoute();
  useEffect(() => {
    document.title = `${project.title} — FRAME`;
    return () => {
      document.title = 'FRAME — 시나리오 개발 작업실';
    };
  }, [project.title]);

  return (
    <>
      <Header title={project.title} save={saveState} />
      <nav className="nav" aria-label="작품 작업 화면">
        <button onClick={() => go('#/')}>
          <LayoutGrid aria-hidden="true" />
          프로젝트
        </button>
        {NAV.map(({ view, label, icon: Icon }) => (
          <button key={view} aria-current={route.view === view ? 'page' : undefined} onClick={() => go(projectPath(project.id, view))}>
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      {saveState === 'conflict' && (
        <div className="banner banner-warn" role="alert">
          <span>{saveError} 다른 창이나 다른 사람이 이 작품을 먼저 저장했습니다.</span>
          <div className="row">
            <button onClick={() => void resolveConflict('theirs')}>저장된 버전 불러오기</button>
            <button className="primary" onClick={() => void resolveConflict('mine')}>
              내 버전으로 덮어쓰기
            </button>
          </div>
        </div>
      )}
      <main className={`screen screen-${route.view}`}>
        {route.view === 'write' && <Writer sceneParam={route.param} />}
        {route.view === 'board' && <Board />}
        {route.view === 'review' && <Review proposalId={route.param} />}
        {route.view === 'drafts' && <Drafts />}
        {route.view === 'bible' && <Bible />}
        {route.view === 'parallel' && <Parallel />}
        {route.view === 'reports' && <Reports />}
      </main>
      <Footer status={status} />
    </>
  );
}
