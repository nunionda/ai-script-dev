import { useState } from 'react';
import { Lock, LockOpen, Tag, X } from 'lucide-react';
import type { ElementMark, MotifStage } from '../../shared/types';
import { STAGE_LABEL } from '../../shared/audit';
import { useProject } from '../state';

/** 커서가 있는 요소의 【확정】·〈극중극〉·태그 표시 */
export function MarkBar({ elementId }: { elementId: string }) {
  const { project, update } = useProject();
  const mark = project.elementMarks[elementId] ?? {};
  const [cat, setCat] = useState('');
  const [stage, setStage] = useState<MotifStage | ''>('');
  const names = new Map(project.tagCategories.map((c) => [c.id, c]));
  const chosen = names.get(cat);

  const setMark = (next: ElementMark) =>
    update((p) => {
      const elementMarks = { ...p.elementMarks };
      if (next.locked || next.play || next.tags?.length) elementMarks[elementId] = next;
      else delete elementMarks[elementId];
      return { elementMarks };
    });

  const addTag = () => {
    if (!chosen) return;
    const tag = { cat: chosen.id, ...(chosen.kind === 'motif' && stage ? { stage } : {}) };
    setMark({ ...mark, tags: [...(mark.tags ?? []), tag] });
    setCat('');
    setStage('');
  };

  return (
    <div className="mark-bar" role="group" aria-label="요소 표시">
      <button
        className={`small-btn${mark.locked ? ' on' : ''}`}
        aria-pressed={Boolean(mark.locked)}
        title="작가 확정 표현 — AI 수정안이 바꿀 수 없습니다"
        onClick={() => setMark({ ...mark, locked: !mark.locked || undefined })}
      >
        {mark.locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
        확정
      </button>
      <button
        className={`small-btn${mark.play ? ' on' : ''}`}
        aria-pressed={Boolean(mark.play)}
        title="극중극 — 금지어 점검에서 제외합니다"
        onClick={() => setMark({ ...mark, play: !mark.play || undefined })}
      >
        극중극
      </button>
      {(mark.tags ?? []).map((t, i) => (
        <span key={i} className="tag">
          {names.get(t.cat)?.name ?? '삭제된 분류'}
          {t.stage && ` · ${STAGE_LABEL[t.stage]}`}
          <button
            className="icon-btn tiny"
            aria-label="태그 빼기"
            onClick={() => setMark({ ...mark, tags: mark.tags!.filter((_, j) => j !== i) })}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
      {project.tagCategories.length > 0 && (
        <span className="row tight">
          <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="태그 분류">
            <option value="">태그…</option>
            {project.tagCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {chosen?.kind === 'motif' && (
            <select value={stage} onChange={(e) => setStage(e.target.value as MotifStage | '')} aria-label="모티프 단계">
              <option value="">단계</option>
              {(Object.keys(STAGE_LABEL) as MotifStage[]).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          )}
          <button className="small-btn" disabled={!chosen} onClick={addTag}>
            <Tag aria-hidden="true" />
            붙이기
          </button>
        </span>
      )}
    </div>
  );
}
