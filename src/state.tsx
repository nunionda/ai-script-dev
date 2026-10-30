import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Project } from '../shared/types';
import { api, ApiError, type ProjectPatch } from './api';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

interface ProjectContextValue {
  project: Project;
  update: (patch: ProjectPatch | ((p: Project) => ProjectPatch)) => void;
  saveState: SaveState;
  saveError: string;
  /** 대기 중인 저장을 즉시 실행 */
  flush: () => Promise<void>;
  resolveConflict: (keep: 'mine' | 'theirs') => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside ProjectProvider');
  return ctx;
}

const FIELDS = ['title', 'logline', 'genre', 'author', 'contact', 'format', 'status', 'elements', 'acts', 'sceneMeta', 'characters',
  'rulings',
  'oneAction',
  'hardRules',
  'bannedWords',
  'tagCategories',
  'elementMarks',
  'auditOptions',
  'numberingLocked',
  'openQuestions',
  'translation',
] as const;

function dataOf(p: Project): ProjectPatch {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = p[k];
  return out as ProjectPatch;
}

export function ProjectProvider({ initial, children }: { initial: Project; children: ReactNode }) {
  const [project, setProject] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const latest = useRef(project);
  const rev = useRef(initial.rev);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const conflict = useRef(false);

  latest.current = project;

  /** keepalive: 페이지를 떠나는 중에도 요청이 끝까지 전송되도록 */
  const save = useCallback(async (keepalive = false): Promise<void> => {
    window.clearTimeout(timer.current);
    if (conflict.current) return;
    if (saving.current) {
      await saving.current;
      if (dirty.current) return save(keepalive);
      return;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    const snapshot = latest.current;
    const run = (async () => {
      try {
        const saved = await api.saveProject(snapshot.id, dataOf(snapshot), rev.current, keepalive);
        rev.current = saved.rev;
        setProject((p) => ({ ...p, rev: saved.rev, updatedAt: saved.updatedAt }));
        setSaveError('');
        setSaveState(dirty.current ? 'dirty' : 'saved');
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          conflict.current = true;
          setSaveState('conflict');
          setSaveError(e.message);
        } else {
          dirty.current = true;
          setSaveState('error');
          setSaveError(e instanceof Error ? e.message : '저장하지 못했습니다.');
          timer.current = window.setTimeout(() => void save(), 5000);
        }
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
    if (dirty.current && !conflict.current) timer.current = window.setTimeout(() => void save(), 800);
  }, []);

  const update = useCallback(
    (patch: ProjectPatch | ((p: Project) => ProjectPatch)) => {
      setProject((p) => {
        const next = { ...p, ...(typeof patch === 'function' ? patch(p) : patch) };
        latest.current = next;
        return next;
      });
      dirty.current = true;
      if (!conflict.current) setSaveState((s) => (s === 'saving' ? s : 'dirty'));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), 900);
    },
    [save],
  );

  const resolveConflict = useCallback(
    async (keep: 'mine' | 'theirs') => {
      if (keep === 'theirs') {
        const fresh = await api.getProject(latest.current.id);
        rev.current = fresh.rev;
        conflict.current = false;
        dirty.current = false;
        latest.current = fresh;
        setProject(fresh);
        setSaveState('saved');
        setSaveError('');
        return;
      }
      const saved = await api.saveProject(latest.current.id, dataOf(latest.current));
      rev.current = saved.rev;
      conflict.current = false;
      dirty.current = false;
      setProject((p) => ({ ...p, rev: saved.rev, updatedAt: saved.updatedAt }));
      setSaveState('saved');
      setSaveError('');
    },
    [],
  );

  // 창을 닫거나 다른 작품으로 이동할 때 남은 변경을 저장
  useEffect(() => {
    const onHide = () => {
      if (dirty.current && !conflict.current) void save(true);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) {
        onHide();
        e.preventDefault();
      }
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.clearTimeout(timer.current);
      onHide();
    };
  }, [save]);

  const value = useMemo(
    () => ({ project, update, saveState, saveError, flush: () => save(), resolveConflict }),
    [project, update, saveState, saveError, save, resolveConflict],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

// ---------------------------------------------------------------- 사용자 (로컬 설정)

export interface Me {
  name: string;
  role: string;
}

export function loadMe(): Me {
  try {
    const raw = localStorage.getItem('frame.me');
    if (raw) return JSON.parse(raw);
  } catch {
    /* 저장소를 쓸 수 없는 환경 */
  }
  return { name: '', role: '작가' };
}

export function saveMe(me: Me) {
  try {
    localStorage.setItem('frame.me', JSON.stringify(me));
  } catch {
    /* 무시 */
  }
}

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`frame.pref.${key}`);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`frame.pref.${key}`, JSON.stringify(v));
      } catch {
        /* 무시 */
      }
    },
    [key],
  );
  return [value, set];
}
