import { Bookmark } from 'lucide-react';
import type { Act } from '../../shared/types';
import type { SceneInfo } from '../../shared/screenplay';

interface Props {
  scenes: SceneInfo[];
  acts: Act[];
  currentSceneId: string | null;
  markers: Map<string, { proposals: number; comments: number }>;
  onSelect: (sceneId: string) => void;
  intent: string;
  onIntentChange: (intent: string) => void;
  format: 'korean' | 'hollywood';
}

export function SceneNav({ scenes, acts, currentSceneId, markers, onSelect, intent, onIntentChange, format }: Props) {
  const groups = acts.map((a) => ({ act: a, scenes: scenes.filter((s) => s.actId === a.id) })).filter((g) => g.scenes.length);
  const orphan = scenes.filter((s) => !acts.some((a) => a.id === s.actId));
  if (orphan.length) groups.unshift({ act: { id: '', title: '막 미지정' }, scenes: orphan });

  return (
    <aside className="scenes" aria-label="장면 탐색">
      <p className="eyebrow">SCENES</p>
      <h2>장면 탐색</h2>
      {!scenes.length && <p className="muted small">씬 헤딩(Ctrl+1)을 쓰면 장면이 여기에 나타납니다.</p>}
      {groups.map((g, gi) => (
        <div key={g.act.id || 'none'}>
          <p className="act-label">
            {g.act.id ? `${gi + 1 - (orphan.length ? 1 : 0)}막 · ` : ''}
            {g.act.title}
          </p>
          {g.scenes.map((s) => {
            const mark = markers.get(s.id);
            return (
              <button key={s.id} className="scene-btn" aria-pressed={s.id === currentSceneId} onClick={() => onSelect(s.id)}>
                <span className="scene-no">{format === 'korean' ? `S#${s.number}` : s.number}</span>
                <div>
                  {s.parts.location || s.heading || '(제목 없는 장면)'}
                  <small>{[s.parts.place, s.parts.time].filter(Boolean).join(' · ')}</small>
                </div>
                {mark && (mark.proposals > 0 || mark.comments > 0) && (
                  <span
                    className="dot"
                    aria-label={[mark.proposals && `수정안 ${mark.proposals}개`, mark.comments && `의견 ${mark.comments}개`].filter(Boolean).join(', ')}
                  />
                )}
              </button>
            );
          })}
        </div>
      ))}
      {currentSceneId && (
        <div className="scene-note">
          <Bookmark aria-hidden="true" />
          <label htmlFor="scene-intent">장면의 의도</label>
          <textarea
            id="scene-intent"
            rows={4}
            value={intent}
            placeholder="이 장면에서 무엇이 드러나야 하나요?"
            onChange={(e) => onIntentChange(e.target.value)}
          />
        </div>
      )}
    </aside>
  );
}
