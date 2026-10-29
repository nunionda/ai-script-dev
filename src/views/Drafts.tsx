import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import type { Snapshot, SnapshotSummary } from '../../shared/types';
import { diffElements, summarizeDiff, type DiffOp } from '../../shared/diff';
import { getScenes } from '../../shared/screenplay';
import { api } from '../api';
import { useProject } from '../state';
import { ScriptLine } from '../components/ScriptView';
import { timeAgo, useAnnounce } from '../ui';

const CONTEXT = 2;

/** 바뀐 곳 주변만 보여 주도록 변경 구간을 묶는다 */
function hunks(ops: DiffOp[]): { ops: DiffOp[]; skippedBefore: number }[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  const out: { ops: DiffOp[]; skippedBefore: number }[] = [];
  let skipped = 0;
  let current: DiffOp[] | null = null;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      skipped++;
      current = null;
      return;
    }
    if (!current) {
      current = [];
      out.push({ ops: current, skippedBefore: skipped });
      skipped = 0;
    }
    current.push(op);
  });
  return out;
}

export function Drafts() {
  const { project, update, flush } = useProject();
  const [list, setList] = useState<SnapshotSummary[] | null>(null);
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();

  const load = useCallback(() => api.listSnapshots(project.id).then(setList), [project.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const ops = useMemo(() => (selected ? diffElements(selected.elements, project.elements) : []), [selected, project.elements]);
  const summary = summarizeDiff(ops);
  const groups = useMemo(() => hunks(ops), [ops]);

  const save = async () => {
    setBusy(true);
    try {
      await flush();
      const s = await api.createSnapshot(project.id, label, note);
      setLabel('');
      setNote('');
      await load();
      announce(`"${s.label}"을(를) 저장했습니다.`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!selected) return;
    if (!confirm(`현재 원고를 "${selected.label}"(으)로 되돌릴까요? 현재 원고는 먼저 작업본으로 저장됩니다.`)) return;
    setBusy(true);
    try {
      await flush();
      await api.createSnapshot(project.id, `복원 전 자동 저장`, `"${selected.label}" 복원 직전의 원고`);
      update({ elements: selected.elements });
      await load();
      announce(`"${selected.label}"(으)로 원고를 되돌렸습니다.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SnapshotSummary) => {
    if (!confirm(`"${s.label}"을(를) 삭제할까요?`)) return;
    await api.deleteSnapshot(s.id);
    if (selected?.id === s.id) setSelected(null);
    await load();
  };

  return (
    <div className="page drafts">
      <div className="heading">
        <div>
          <p className="eyebrow">DRAFTS</p>
          <h1>지나온 원고를 남겨 두기.</h1>
          <p className="muted">작업본을 저장하고 현재 원고와 비교하거나 되돌릴 수 있습니다.</p>
        </div>
      </div>
      <div className="drafts-layout">
        <aside>
          <form
            className="form card"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              작업본 이름
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`작업본 ${String((list?.length ?? 0) + 1).padStart(2, '0')}`} />
            </label>
            <label>
              메모
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 2고 — 아버지 대사 정리" />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              현재 원고를 작업본으로 저장
            </button>
          </form>
          <div className="snapshot-list">
            {list?.length === 0 && <p className="muted small">아직 저장한 작업본이 없습니다.</p>}
            {list?.map((s) => (
              <div key={s.id} className="snapshot-item" aria-current={selected?.id === s.id ? 'true' : undefined}>
                <button className="snapshot-open" onClick={() => void api.getSnapshot(s.id).then(setSelected)}>
                  <strong>{s.label}</strong>
                  <span className="muted small">
                    {timeAgo(s.createdAt)} · {s.sceneCount}개 장면 · {s.pageCount}쪽
                  </span>
                  {s.note && <span className="small">{s.note}</span>}
                </button>
                <button className="icon-btn" onClick={() => void remove(s)} aria-label={`${s.label} 삭제`}>
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </aside>
        <section className="compare">
          {!selected ? (
            <div className="empty-state">
              <History aria-hidden="true" />
              <p className="muted">왼쪽에서 작업본을 고르면 현재 원고와 비교합니다.</p>
            </div>
          ) : (
            <>
              <div className="row compare-head">
                <div>
                  <strong>{selected.label}</strong> → 현재 원고
                  <p className="muted small">
                    고침 {summary.changed} · 추가 {summary.added} · 삭제 {summary.removed} · 장면 {getScenes({ elements: selected.elements, acts: [], sceneMeta: {} }).length} → {getScenes(project).length}
                  </p>
                </div>
                <button onClick={() => void restore()} disabled={busy}>
                  이 작업본으로 되돌리기
                </button>
              </div>
              {!groups.length && <p className="muted">현재 원고와 같습니다.</p>}
              <div className="unified-diff">
                {groups.map((g, gi) => (
                  <div key={gi}>
                    {g.skippedBefore > 0 && <p className="skipped">… 같은 내용 {g.skippedBefore}개 요소 …</p>}
                    {g.ops.map((op, i) => {
                      if (op.kind === 'same') return <ScriptLine key={i} e={op.b} />;
                      if (op.kind === 'del') return <ScriptLine key={i} e={op.a} className="removed" />;
                      if (op.kind === 'add') return <ScriptLine key={i} e={op.b} className="added" />;
                      return (
                        <div key={i}>
                          <ScriptLine e={op.a} className="removed" />
                          <ScriptLine e={op.b} className="added" />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
