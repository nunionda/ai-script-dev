import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

// ---------------------------------------------------------------- 라우팅 (hash)

export type View = 'write' | 'board' | 'review' | 'drafts' | 'reports' | 'print';

export interface Route {
  projectId: string | null;
  view: View;
  param: string | null;
}

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    const view = (['write', 'board', 'review', 'drafts', 'reports', 'print'].includes(parts[2]) ? parts[2] : 'write') as View;
    return { projectId: parts[1], view, param: parts[3] ? decodeURIComponent(parts[3]) : null };
  }
  return { projectId: null, view: 'write', param: null };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function go(path: string) {
  location.hash = path;
}

export const projectPath = (id: string, view: View = 'write', param?: string) => `#/p/${id}/${view}${param ? `/${encodeURIComponent(param)}` : ''}`;

// ---------------------------------------------------------------- 상태 알림

const StatusContext = createContext<(message: string) => void>(() => undefined);

export function StatusProvider({ children }: { children: (status: string) => ReactNode }) {
  const [status, setStatus] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const announce = useCallback((message: string) => {
    setStatus(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(''), 6000);
  }, []);
  return <StatusContext.Provider value={announce}>{children(status)}</StatusContext.Provider>;
}

export const useAnnounce = () => useContext(StatusContext);

// ---------------------------------------------------------------- 공용 컴포넌트

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'script';
}
