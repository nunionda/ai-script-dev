import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import { TextSelection } from '@tiptap/pm/state';
import type { ElementType, ScriptElement, ScriptFormat } from '../../shared/types';
import { ELEMENT_INFO, characterName, parseHeading, sceneIdAt } from '../../shared/screenplay';
import { suggest } from '../../shared/suggest';
import { fromFountain } from '../../shared/fountain';
import {
  ScreenplayKeymap,
  ScreenplayLayout,
  ScriptDocument,
  ScriptElementNode,
  UniqueIds,
  currentElement,
  docToElements,
  elementsToDoc,
  layoutKey,
} from './extensions';

export interface CursorInfo {
  sceneId: string | null;
  elementId: string;
  type: ElementType;
}

interface Props {
  initial: ScriptElement[];
  format: ScriptFormat;
  extraCharacters: string[];
  onChange: (elements: ScriptElement[]) => void;
  onCursor: (info: CursorInfo) => void;
  onReady: (editor: Editor | null) => void;
}

interface SuggestState {
  items: string[];
  index: number;
  left: number;
  top: number;
  /** 후보를 만든 요소 위치와 텍스트 */
  pos: number;
}

export function ScriptEditor({ initial, format, extraCharacters, onChange, onCursor, onReady }: Props) {
  const formatRef = useRef(format);
  formatRef.current = format;
  const extraRef = useRef(extraCharacters);
  extraRef.current = extraCharacters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  const [sugg, setSugg] = useState<SuggestState | null>(null);
  const suggRef = useRef<SuggestState | null>(null);
  suggRef.current = sugg;
  const dismissed = useRef<string>('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const changeTimer = useRef<number | undefined>(undefined);
  const pending = useRef(false);
  const emit = (ed: Editor) => {
    window.clearTimeout(changeTimer.current);
    if (!pending.current) return;
    pending.current = false;
    onChangeRef.current(docToElements(ed.state.doc));
  };

  const editor = useEditor({
    extensions: [
      ScriptDocument,
      ScriptElementNode,
      Text,
      History.configure({ depth: 500 }),
      ScreenplayKeymap,
      UniqueIds,
      ScreenplayLayout.configure({ getFormat: () => formatRef.current }),
      Placeholder.configure({
        placeholder: ({ node }) => `${ELEMENT_INFO[node.attrs.type as ElementType].label}…`,
        showOnlyCurrent: true,
      }),
    ],
    content: elementsToDoc(initial),
    editorProps: {
      attributes: { class: 'script-editor', spellcheck: 'false', 'aria-label': '시나리오 원고' },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false;
        const s = suggRef.current;
        if (!s || !s.items.length) return false;
        if (event.key === 'ArrowDown') {
          setSugg({ ...s, index: (s.index + 1) % s.items.length });
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSugg({ ...s, index: (s.index - 1 + s.items.length) % s.items.length });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (event.shiftKey) return false;
          acceptRef.current(s.items[s.index]);
          return true;
        }
        if (event.key === 'Escape') {
          dismissed.current = `${s.pos}:${_view.state.doc.nodeAt(s.pos)?.textContent ?? ''}`;
          setSugg(null);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const html = event.clipboardData?.getData('text/html') ?? '';
        const text = event.clipboardData?.getData('text/plain') ?? '';
        // 다른 프로그램에서 붙여넣은 여러 문단 텍스트는 Fountain 규칙으로 해석
        if (html.includes('data-type=') || !/\n\s*\n/.test(text)) return false;
        const parsed = fromFountain(text).elements;
        if (parsed.length < 2) return false;
        const { schema } = view.state;
        const nodes = parsed.map((e) => schema.nodes.element.create({ type: e.type, id: null }, e.text ? schema.text(e.text) : undefined));
        const cur = currentElement(view.state);
        if (!cur) return false;
        const insertAt = cur.node.textContent ? cur.pos + cur.node.nodeSize : cur.pos;
        let tr = view.state.tr;
        if (!cur.node.textContent) tr = tr.delete(cur.pos, cur.pos + cur.node.nodeSize);
        tr = tr.insert(insertAt, nodes);
        const end = insertAt + nodes.reduce((a, n) => a + n.nodeSize, 0);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size) - 1)));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      pending.current = true;
      window.clearTimeout(changeTimer.current);
      changeTimer.current = window.setTimeout(() => emit(editor), 250);
    },
    onTransaction: ({ editor }) => refresh(editor),
    onBlur: ({ editor }) => {
      emit(editor);
      setSugg(null);
    },
  });

  const acceptRef = useRef<(text: string) => void>(() => undefined);
  acceptRef.current = (text: string) => {
    if (!editor) return;
    const cur = currentElement(editor.state);
    if (!cur) return;
    const tr = editor.state.tr.insertText(text, cur.pos + 1, cur.pos + 1 + cur.node.content.size);
    tr.setSelection(TextSelection.create(tr.doc, cur.pos + 1 + text.length));
    editor.view.dispatch(tr);
  };

  function refresh(ed: Editor) {
    const state = ed.state;
    const cur = currentElement(state);
    if (!cur) return;
    // 커서 정보
    const elements: { id: string; type: string }[] = [];
    state.doc.forEach((n) => elements.push({ id: n.attrs.id, type: n.attrs.type }));
    onCursorRef.current({
      sceneId: sceneIdAt(elements as ScriptElement[], cur.index),
      elementId: cur.node.attrs.id,
      type: cur.type,
    });

    // 자동완성
    const text = cur.node.textContent;
    const atEnd = state.selection.empty && state.selection.$from.parentOffset === text.length;
    const key = `${cur.pos}:${text}`;
    if (!ed.isFocused || !atEnd || dismissed.current === key || !['character', 'scene', 'transition'].includes(cur.type)) {
      if (suggRef.current) setSugg(null);
      return;
    }
    dismissed.current = '';
    const characters = new Set<string>();
    const locations = new Set<string>();
    state.doc.forEach((n, offset) => {
      if (offset === cur.pos) return;
      if (n.attrs.type === 'character') {
        const name = characterName(n.textContent);
        if (name) characters.add(name);
      } else if (n.attrs.type === 'scene') {
        const loc = parseHeading(n.textContent).location;
        if (loc) locations.add(loc);
      }
    });
    for (const c of extraRef.current) characters.add(c);
    const items = suggest(cur.type, text, { characters: [...characters], locations: [...locations], format: formatRef.current });
    if (!items.length) {
      if (suggRef.current) setSugg(null);
      return;
    }
    const coords = ed.view.coordsAtPos(state.selection.from);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const prev = suggRef.current;
    setSugg({
      items,
      index: prev && prev.pos === cur.pos && prev.index < items.length && prev.items[prev.index] === items[prev.index] ? prev.index : 0,
      left: coords.left - box.left,
      top: coords.bottom - box.top + 4,
      pos: cur.pos,
    });
  }

  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);

  // 서식(한국식/할리우드식)이 바뀌면 장면 번호 표기를 다시 그린다
  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(layoutKey, true));
  }, [editor, format]);

  useEffect(
    () => () => {
      if (editor && !editor.isDestroyed) emit(editor);
    },
    [editor],
  );

  return (
    <div className="editor-wrap" ref={wrapRef}>
      <EditorContent editor={editor} />
      {sugg && (
        <ul className="smart-type" role="listbox" aria-label="자동 완성" style={{ left: sugg.left, top: sugg.top }}>
          {sugg.items.map((item, i) => (
            <li
              key={item}
              role="option"
              aria-selected={i === sugg.index}
              onMouseDown={(e) => {
                e.preventDefault();
                acceptRef.current(item);
              }}
            >
              {item}
            </li>
          ))}
          <li className="smart-type-hint" aria-hidden="true">
            ↵ / Tab 선택 · Esc 닫기
          </li>
        </ul>
      )}
    </div>
  );
}
