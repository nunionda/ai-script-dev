import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { Download, Keyboard, Maximize2, Minimize2, Search, X } from 'lucide-react';
import type { ElementType, Proposal, SceneComment, ScriptElement } from '../../shared/types';
import { ELEMENT_INFO, getScenes } from '../../shared/screenplay';
import { paginate } from '../../shared/pagination';
import { toFountain } from '../../shared/fountain';
import { toFdx } from '../../shared/fdx';
import { toDocx } from '../../shared/docx';
import { toHwpx } from '../../shared/hwpx';
import { api } from '../api';
import { useProject, usePref } from '../state';
import { ScriptEditor, type CursorInfo } from '../editor/ScriptEditor';
import { focusElement, setElementType } from '../editor/extensions';
import { SceneNav } from '../components/SceneNav';
import { AiPanel } from '../components/AiPanel';
import { MarkBar } from '../components/MarkBar';
import { Modal, download, projectPath, safeFilename, useAnnounce } from '../ui';

export function Writer({ sceneParam }: { sceneParam: string | null }) {
  const { project, update, flush } = useProject();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [focusMode, setFocusMode] = usePref('focusMode', false);
  const [paper, setPaper] = usePref<'serif' | 'mono'>('paperFont', 'serif');
  const [comments, setComments] = useState<SceneComment[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const announce = useAnnounce();

  const loadComments = useCallback(() => {
    api.listComments(project.id).then(setComments).catch(() => undefined);
  }, [project.id]);

  useEffect(() => {
    loadComments();
    api.listProposals(project.id).then(setProposals).catch(() => undefined);
    api
      .aiStatus()
      .then((s) => setAiConfigured(s.configured))
      .catch(() => setAiConfigured(null));
  }, [project.id, loadComments]);

  const scenes = useMemo(
    () => getScenes(project),
    [project.elements, project.acts, project.sceneMeta, project.numberingLocked, project.format],
  );
  const layout = useMemo(
    () => ({
      sceneMeta: project.sceneMeta,
      numberingLocked: project.numberingLocked,
      marks: project.elementMarks,
      tagNames: new Map(project.tagCategories.map((c) => [c.id, c.name])),
    }),
    [project.sceneMeta, project.numberingLocked, project.elementMarks, project.tagCategories],
  );
  const pagination = useMemo(() => paginate(project.elements), [project.elements]);
  const currentScene = scenes.find((s) => s.id === cursor?.sceneId) ?? null;

  const markers = useMemo(() => {
    const m = new Map<string, { proposals: number; comments: number }>();
    for (const p of proposals) if (p.status === 'pending' || p.status === 'held') {
      const v = m.get(p.sceneId) ?? { proposals: 0, comments: 0 };
      v.proposals++;
      m.set(p.sceneId, v);
    }
    for (const c of comments) if (!c.resolved) {
      const v = m.get(c.sceneId) ?? { proposals: 0, comments: 0 };
      v.comments++;
      m.set(c.sceneId, v);
    }
    return m;
  }, [proposals, comments]);

  const onChange = useCallback((elements: ScriptElement[]) => update({ elements }), [update]);
  const onUnlock = useCallback(
    (ids: string[]) =>
      update((p) => {
        const elementMarks = { ...p.elementMarks };
        for (const id of ids) {
          const { locked: _locked, ...rest } = elementMarks[id] ?? {};
          if (rest.play || rest.tags?.length) elementMarks[id] = rest;
          else delete elementMarks[id];
        }
        return { elementMarks };
      }),
    [update],
  );
  const onCursor = useCallback((info: CursorInfo) => {
    setCursor((prev) => (prev && prev.sceneId === info.sceneId && prev.type === info.type && prev.elementId === info.elementId ? prev : info));
  }, []);

  // 주소의 장면으로 이동 (보드·검토 화면에서 들어올 때)
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!editor || !sceneParam || jumped.current === sceneParam) return;
    jumped.current = sceneParam;
    requestAnimationFrame(() => focusElement(editor, sceneParam, 'start'));
  }, [editor, sceneParam]);

  // 단축키: Ctrl+F 찾기, Ctrl+Shift+F 집중 모드
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFocusMode(!focusMode);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush().then(() => announce('저장했습니다.'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, setFocusMode, flush, announce]);

  const extraCharacters = useMemo(() => Object.keys(project.characters), [project.characters]);
  const currentPage = cursor ? pagination.pageOf.get(cursor.elementId) : undefined;
  const sceneLabel = currentScene ? `${project.format === 'korean' ? 'S#' : '#'}${currentScene.label} ${currentScene.parts.location || ''}`.trim() : '작품 전체';

  const exportAs = async (kind: 'fountain' | 'fdx' | 'docx' | 'hwpx' | 'pdf') => {
    setExportOpen(false);
    const name = safeFilename(project.title);
    if (kind === 'fountain') download(`${name}.fountain`, toFountain(project), 'text/plain;charset=utf-8');
    if (kind === 'fdx') download(`${name}.fdx`, toFdx(project), 'application/xml;charset=utf-8');
    if (kind === 'docx') download(`${name}.docx`, toDocx(project), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (kind === 'hwpx') download(`${name}.hwpx`, toHwpx(project), 'application/hwp+zip');
    if (kind === 'pdf') {
      await flush();
      window.open(projectPath(project.id, 'print'), '_blank', 'noopener');
    }
    announce(kind === 'pdf' ? '인쇄용 원고를 새 탭에서 열었습니다. 인쇄 대화상자에서 PDF로 저장하세요.' : '파일을 내보냈습니다.');
  };

  return (
    <div className={`writer${focusMode ? ' focused' : ''}`}>
      <div className="document-bar">
        <div className="row tight">
          <strong>{project.title}</strong>
          <span className="muted">
            {scenes.length}개 장면 · {currentPage ? `${currentPage} / ` : ''}
            {pagination.pageCount}쪽
          </span>
        </div>
        <div className="row tight toolbar">
          <label className="sr-only" htmlFor="element-type">
            요소 종류
          </label>
          <select
            id="element-type"
            className="element-select"
            value={cursor?.type ?? 'action'}
            onChange={(e) => {
              if (editor) {
                editor.commands.focus();
                setElementType(editor, e.target.value as ElementType);
              }
            }}
          >
            {Object.entries(ELEMENT_INFO).map(([type, info]) => (
              <option key={type} value={type}>
                {info.label} (Ctrl+{info.key})
              </option>
            ))}
          </select>
          <button className="icon-btn" onClick={() => setFindOpen(true)} aria-label="찾기 및 바꾸기 (Ctrl+F)" title="찾기 및 바꾸기 (Ctrl+F)">
            <Search aria-hidden="true" />
          </button>
          <button className="icon-btn" onClick={() => setHelpOpen(true)} aria-label="키보드 단축키" title="키보드 단축키">
            <Keyboard aria-hidden="true" />
          </button>
          <select className="paper-select" value={paper} onChange={(e) => setPaper(e.target.value as 'serif' | 'mono')} aria-label="원고 서체">
            <option value="serif">명조 · 문학적</option>
            <option value="mono">고정폭 · 표준 서식</option>
          </select>
          <div className="menu-wrap">
            <button onClick={() => setExportOpen(!exportOpen)} aria-expanded={exportOpen}>
              <Download aria-hidden="true" />
              내보내기
            </button>
            {exportOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setExportOpen(false)}>
                <button role="menuitem" onClick={() => void exportAs('pdf')}>
                  PDF · 인쇄용 원고
                </button>
                <button role="menuitem" onClick={() => void exportAs('fdx')}>
                  Final Draft (.fdx)
                </button>
                <button role="menuitem" onClick={() => void exportAs('docx')}>
                  Word (.docx)
                </button>
                <button role="menuitem" onClick={() => void exportAs('hwpx')}>
                  한글 (.hwpx)
                </button>
                <button role="menuitem" onClick={() => void exportAs('fountain')}>
                  Fountain (.fountain)
                </button>
              </div>
            )}
          </div>
          <button onClick={() => setFocusMode(!focusMode)} aria-pressed={focusMode}>
            {focusMode ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            {focusMode ? '패널 다시 열기' : '집중 모드'}
          </button>
        </div>
      </div>

      {findOpen && editor && <FindBar editor={editor} onClose={() => setFindOpen(false)} />}

      <div className="workspace">
        <SceneNav
          scenes={scenes}
          acts={project.acts}
          currentSceneId={cursor?.sceneId ?? null}
          markers={markers}
          format={project.format}
          onSelect={(id) => editor && focusElement(editor, id, 'start')}
          intent={currentScene?.meta.intent ?? ''}
          onIntentChange={(intent) =>
            currentScene &&
            update((p) => ({ sceneMeta: { ...p.sceneMeta, [currentScene.id]: { ...p.sceneMeta[currentScene.id], intent } } }))
          }
        />
        <section className="manuscript" aria-label="원고">
          <div className="paper-tools">
            <span>시나리오 · {project.format === 'korean' ? '한국식 서식' : '할리우드 서식'}</span>
            {cursor?.elementId ? (
              <MarkBar elementId={cursor.elementId} />
            ) : (
              <span>Enter 다음 요소 · Tab 요소 바꾸기</span>
            )}
          </div>
          <article className={`paper paper-${paper} format-${project.format}`}>
            <div className="page-number">
              {project.title} / {currentPage ?? 1}
            </div>
            <ScriptEditor
              initial={project.elements}
              format={project.format}
              layout={layout}
              extraCharacters={extraCharacters}
              onChange={onChange}
              onCursor={onCursor}
              onUnlock={onUnlock}
              onReady={setEditor}
            />
            <div className="paper-end" aria-hidden="true">
              • • •
            </div>
          </article>
        </section>
        <AiPanel
          projectId={project.id}
          sceneId={cursor?.sceneId ?? null}
          sceneLabel={sceneLabel}
          comments={comments}
          onCommentsChange={loadComments}
          aiConfigured={aiConfigured}
        />
      </div>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const announce = useAnnounce();

  const [version, setVersion] = useState(0);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const on = () => setVersion((v) => v + 1);
    editor.on('update', on);
    return () => {
      editor.off('update', on);
    };
  }, [editor]);

  const matches = useMemo(() => {
    if (!query) return [] as { from: number; to: number }[];
    const out: { from: number; to: number }[] = [];
    const q = query.toLowerCase();
    editor.state.doc.forEach((node, offset) => {
      const text = node.textContent.toLowerCase();
      let i = text.indexOf(q);
      while (i >= 0) {
        out.push({ from: offset + 1 + i, to: offset + 1 + i + query.length });
        i = text.indexOf(q, i + Math.max(1, q.length));
      }
    });
    return out;
  }, [query, editor, version]);

  const select = (i: number) => {
    if (!matches.length) return;
    const m = matches[(i + matches.length) % matches.length];
    setIndex((i + matches.length) % matches.length);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).scrollIntoView());
  };

  const replaceOne = () => {
    const m = matches[index];
    if (!m) return;
    editor.view.dispatch(editor.state.tr.insertText(replace, m.from, m.to));
    setTimeout(() => select(index), 0);
  };

  const replaceAll = () => {
    if (!matches.length) return;
    const tr = editor.state.tr;
    for (const m of [...matches].reverse()) tr.insertText(replace, m.from, m.to);
    editor.view.dispatch(tr);
    announce(`${matches.length}곳을 바꿨습니다.`);
  };

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        value={query}
        placeholder="찾기"
        aria-label="찾을 내용"
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            select(e.shiftKey ? index - 1 : matches.length && editor.state.selection.from === matches[index]?.from ? index + 1 : index);
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="muted small">{query ? `${matches.length ? index + 1 : 0} / ${matches.length}` : ''}</span>
      <button onClick={() => select(index - 1)} disabled={!matches.length}>
        이전
      </button>
      <button onClick={() => select(index + 1)} disabled={!matches.length}>
        다음
      </button>
      <input value={replace} placeholder="바꿀 내용" aria-label="바꿀 내용" onChange={(e) => setReplace(e.target.value)} />
      <button onClick={replaceOne} disabled={!matches.length}>
        바꾸기
      </button>
      <button onClick={replaceAll} disabled={!matches.length}>
        모두 바꾸기
      </button>
      <button className="icon-btn" onClick={onClose} aria-label="찾기 닫기">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Enter', '다음 요소 (씬 헤딩 → 지문, 인물 → 대사, 대사 → 지문)'],
    ['빈 요소에서 Enter', '요소 종류 바꾸기 (빈 지문 → 씬 헤딩, 빈 대사 → 지문)'],
    ['Tab / Shift+Tab', '요소 종류 순환 (지문 → 인물 → 전환 → 씬 헤딩, 대사 ↔ 괄호)'],
    ['Shift+Enter', '같은 요소 안에서 줄바꿈'],
    ...Object.values(ELEMENT_INFO).map((i) => [`Ctrl+${i.key}`, i.label] as [string, string]),
    ['↑ ↓ / Enter / Tab', '자동 완성 후보 고르기 (인물 · 장소 · 시간 · 전환)'],
    ['Ctrl+F', '찾기 및 바꾸기'],
    ['Ctrl+Shift+F', '집중 모드'],
    ['Ctrl+Z / Ctrl+Shift+Z', '실행 취소 / 다시 실행'],
    ['Ctrl+S', '바로 저장 (평소에는 자동 저장)'],
  ];
  return (
    <Modal title="키보드 단축키" onClose={onClose}>
      <table className="table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">
                <kbd>{k}</kbd>
              </th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
