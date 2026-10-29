import { Extension, Node, type Editor, type JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { ElementType, ScriptElement, ScriptFormat } from '../../shared/types';
import { ELEMENT_INFO, EMPTY_ENTER, ENTER_NEXT, SHIFT_TAB_NEXT, TAB_NEXT, uid } from '../../shared/screenplay';
import { paginate } from '../../shared/pagination';

export const ScriptDocument = Document.extend({ content: 'element+' });

export const ScriptElementNode = Node.create({
  name: 'element',
  group: 'block',
  content: 'text*',
  marks: '',
  whitespace: 'pre',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'action',
        parseHTML: (el) => (el.getAttribute('data-type') as ElementType) || 'action',
        renderHTML: (attrs) => ({ 'data-type': attrs.type, class: `el el-${attrs.type}` }),
      },
      id: {
        default: null,
        parseHTML: () => null, // 붙여넣기 시 새 id를 받는다
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'p' }, { tag: 'div[data-type]' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'li' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['p', HTMLAttributes, 0];
  },
});

// ---------------------------------------------------------------- 변환

export function elementsToDoc(elements: ScriptElement[]): JSONContent {
  const list = elements.length ? elements : [{ id: uid('e'), type: 'scene' as ElementType, text: '' }];
  return {
    type: 'doc',
    content: list.map((e) => ({
      type: 'element',
      attrs: { type: e.type, id: e.id },
      content: e.text ? [{ type: 'text', text: e.text }] : [],
    })),
  };
}

export function docToElements(doc: PMNode): ScriptElement[] {
  const out: ScriptElement[] = [];
  doc.forEach((node) => {
    out.push({ id: node.attrs.id ?? uid('e'), type: node.attrs.type as ElementType, text: node.textContent });
  });
  return out;
}

// ---------------------------------------------------------------- 명령

export interface CurrentElement {
  index: number;
  pos: number;
  node: PMNode;
  type: ElementType;
}

export function currentElement(state: EditorState): CurrentElement | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const index = $from.index(0);
  const pos = $from.before(1);
  const node = state.doc.child(index);
  return { index, pos, node, type: node.attrs.type };
}

export function setElementType(editor: Editor, type: ElementType): boolean {
  const cur = currentElement(editor.state);
  if (!cur) return false;
  const tr = editor.state.tr;
  tr.setNodeMarkup(cur.pos, undefined, { ...cur.node.attrs, type });
  const text = cur.node.textContent;
  if (type === 'parenthetical' && text === '') {
    tr.insertText('()', cur.pos + 1);
    tr.setSelection(TextSelection.create(tr.doc, cur.pos + 2));
  } else if (cur.type === 'parenthetical' && type !== 'parenthetical' && /^\(\s*\)$/.test(text)) {
    tr.delete(cur.pos + 1, cur.pos + 1 + text.length);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function insertElementAfter(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, cur: CurrentElement, type: ElementType) {
  if (!dispatch) return true;
  const node = state.schema.nodes.element.create({ type, id: uid('e') });
  const after = cur.pos + cur.node.nodeSize;
  const tr = state.tr.insert(after, node);
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  if (type === 'parenthetical') {
    tr.insertText('()', after + 1);
    tr.setSelection(TextSelection.create(tr.doc, after + 2));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

// ---------------------------------------------------------------- 키맵 (Final Draft 방식)

export const ScreenplayKeymap = Extension.create({
  name: 'screenplayKeymap',
  priority: 1000,

  addKeyboardShortcuts() {
    const typeShortcuts: Record<string, () => boolean> = {};
    for (const [type, info] of Object.entries(ELEMENT_INFO)) {
      typeShortcuts[`Mod-${info.key}`] = () => setElementType(this.editor, type as ElementType);
    }

    return {
      ...typeShortcuts,
      Enter: () => {
        const { state, view } = this.editor;
        const { selection } = state;
        const cur = currentElement(state);
        if (!cur) return false;
        if (!selection.empty) return false;
        const text = cur.node.textContent;
        const offset = selection.$from.parentOffset;

        if (text.trim() === '' || (cur.type === 'parenthetical' && /^\(\s*\)$/.test(text))) {
          const to = EMPTY_ENTER[cur.type];
          if (to) return setElementType(this.editor, to);
          return insertElementAfter(state, view.dispatch, cur, ENTER_NEXT[cur.type]);
        }
        // 괄호 안에서 Enter → 괄호를 닫고 대사로
        if (cur.type === 'parenthetical' && offset === text.length - 1 && text.endsWith(')')) {
          return insertElementAfter(state, view.dispatch, cur, 'dialogue');
        }
        if (offset === text.length) {
          return insertElementAfter(state, view.dispatch, cur, ENTER_NEXT[cur.type]);
        }
        if (offset === 0) {
          // 요소 앞에 빈 요소를 넣는다 (기존 요소의 id·장면 정보 유지)
          const before = state.schema.nodes.element.create({ type: cur.type === 'scene' ? 'action' : cur.type, id: uid('e') });
          view.dispatch(state.tr.insert(cur.pos, before).scrollIntoView());
          return true;
        }
        // 중간에서 나누기: 뒷부분은 같은 종류의 새 요소
        const tr = state.tr.split(selection.from, 1, [{ type: state.schema.nodes.element, attrs: { type: cur.type, id: uid('e') } }]);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      'Shift-Enter': () => {
        this.editor.view.dispatch(this.editor.state.tr.insertText('\n').scrollIntoView());
        return true;
      },
      Tab: () => {
        const cur = currentElement(this.editor.state);
        if (!cur) return false;
        return setElementType(this.editor, TAB_NEXT[cur.type]);
      },
      'Shift-Tab': () => {
        const cur = currentElement(this.editor.state);
        if (!cur) return false;
        return setElementType(this.editor, SHIFT_TAB_NEXT[cur.type]);
      },
    };
  },
});

// ---------------------------------------------------------------- 고유 id 보장

export const UniqueIds = Extension.create({
  name: 'uniqueIds',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('uniqueIds'),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          state.doc.forEach((node, offset) => {
            const id = node.attrs.id as string | null;
            if (!id || seen.has(id)) {
              tr ??= state.tr;
              tr.setNodeMarkup(offset, undefined, { ...node.attrs, id: uid('e') });
            } else seen.add(id);
          });
          if (tr) (tr as Transaction).setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------- 페이지 나눔·장면 번호 표시

export const layoutKey = new PluginKey<DecorationSet>('screenplayLayout');

export interface LayoutOptions {
  getFormat: () => ScriptFormat;
}

function buildDecorations(doc: PMNode, format: ScriptFormat): DecorationSet {
  const elements = docToElements(doc);
  const { breaks } = paginate(elements);
  const decos: Decoration[] = [];
  let sceneNo = 0;
  doc.forEach((node, offset) => {
    const id = node.attrs.id as string;
    const page = id ? breaks.get(id) : undefined;
    if (page) {
      decos.push(
        Decoration.widget(
          offset,
          () => {
            const d = document.createElement('div');
            d.className = 'page-break';
            d.contentEditable = 'false';
            d.setAttribute('aria-hidden', 'true');
            d.dataset.page = String(page);
            d.innerHTML = `<span>${page}.</span>`;
            return d;
          },
          { side: -1, key: `pb-${page}-${id}`, ignoreSelection: true },
        ),
      );
    }
    if (node.attrs.type === 'scene') {
      sceneNo++;
      decos.push(Decoration.node(offset, offset + node.nodeSize, { 'data-scene-number': format === 'korean' ? `S#${sceneNo}.` : String(sceneNo) }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const ScreenplayLayout = Extension.create<LayoutOptions>({
  name: 'screenplayLayout',
  addOptions() {
    return { getFormat: () => 'korean' as ScriptFormat };
  },
  addProseMirrorPlugins() {
    const getFormat = this.options.getFormat;
    return [
      new Plugin<DecorationSet>({
        key: layoutKey,
        state: {
          init: (_, state) => buildDecorations(state.doc, getFormat()),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(layoutKey) ? buildDecorations(tr.doc, getFormat()) : old),
        },
        props: {
          decorations: (state) => layoutKey.getState(state),
        },
      }),
    ];
  },
});

/** 커서를 요소 id 위치로 옮기고 화면에 보이게 한다 */
export function focusElement(editor: Editor, id: string, block: ScrollLogicalPosition = 'center') {
  let target = -1;
  editor.state.doc.forEach((node, offset) => {
    if (target < 0 && node.attrs.id === id) target = offset;
  });
  if (target < 0) return;
  const node = editor.state.doc.nodeAt(target)!;
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target + 1 + node.content.size));
  editor.view.dispatch(tr);
  editor.view.focus();
  const dom = editor.view.nodeDOM(target);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block, behavior: 'smooth' });
}
