import { useMemo } from 'react';
import { characterStats, getScenes } from '../../shared/screenplay';
import { formatEighths, paginate } from '../../shared/pagination';
import { useProject } from '../state';
import { go, projectPath } from '../ui';

export function Reports() {
  const { project, update } = useProject();
  const scenes = useMemo(() => getScenes(project), [project]);
  const pagination = useMemo(() => paginate(project.elements), [project.elements]);
  const stats = useMemo(() => characterStats(project.elements), [project.elements]);
  const locations = useMemo(() => {
    const m = new Map<string, { count: number; eighths: number; times: Set<string> }>();
    for (const s of scenes) {
      const key = s.parts.location || '(장소 미정)';
      const v = m.get(key) ?? { count: 0, eighths: 0, times: new Set<string>() };
      v.count++;
      v.eighths += pagination.sceneEighths.get(s.id) ?? 0;
      if (s.parts.time) v.times.add(s.parts.time);
      m.set(key, v);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [scenes, pagination]);
  const characterNames = [...new Set([...stats.map((s) => s.name), ...Object.keys(project.characters)])];

  return (
    <div className="page reports">
      <div className="heading">
        <div>
          <p className="eyebrow">REPORTS & SETTINGS</p>
          <h1>작품을 한눈에.</h1>
          <p className="muted">
            {scenes.length}개 장면 · 약 {pagination.pageCount}쪽 · 인물 {stats.length}명 · 장소 {locations.length}곳
          </p>
        </div>
      </div>

      <div className="reports-grid">
        <section className="card form">
          <h2>작품 정보</h2>
          <label>
            제목
            <input value={project.title} onChange={(e) => update({ title: e.target.value })} />
          </label>
          <label>
            로그라인
            <textarea rows={2} value={project.logline} onChange={(e) => update({ logline: e.target.value })} />
          </label>
          <div className="row tight">
            <label>
              장르
              <input value={project.genre} onChange={(e) => update({ genre: e.target.value })} placeholder="장편 / 드라마" />
            </label>
            <label>
              진행 상태
              <input value={project.status} onChange={(e) => update({ status: e.target.value })} placeholder="2고 개발 중" />
            </label>
          </div>
          <div className="row tight">
            <label>
              작가
              <input value={project.author} onChange={(e) => update({ author: e.target.value })} />
            </label>
            <label>
              연락처 (표지)
              <input value={project.contact} onChange={(e) => update({ contact: e.target.value })} />
            </label>
          </div>
          <label>
            원고 서식
            <select value={project.format} onChange={(e) => update({ format: e.target.value as 'korean' | 'hollywood' })}>
              <option value="korean">한국식 — S#1. 내부. 영사실 - 밤</option>
              <option value="hollywood">할리우드식 — 1 INT. PROJECTION BOOTH - NIGHT</option>
            </select>
          </label>
        </section>

        <section className="card">
          <h2>판정서</h2>
          <p className="muted small">AI 개발 파트너가 어떤 경우에도 지키는 최우선 규칙입니다.</p>
          <ul className="plain-list">
            {project.rulings.map((r) => (
              <li key={r.id}>
                <strong>{r.code}</strong> {r.text}
              </li>
            ))}
          </ul>
          {!project.rulings.length && <p className="muted small">아직 판정서가 없습니다.</p>}
          <button onClick={() => go(projectPath(project.id, 'bible'))}>작품 바이블에서 편집 →</button>
        </section>

        <section className="card span-2">
          <h2>인물</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">인물</th>
                <th scope="col" className="num">
                  대사
                </th>
                <th scope="col" className="num">
                  등장 장면
                </th>
                <th scope="col" className="num">
                  첫 등장
                </th>
                <th scope="col">인물 설정 (AI 개발 파트너가 참고)</th>
              </tr>
            </thead>
            <tbody>
              {characterNames.map((name) => {
                const s = stats.find((x) => x.name === name);
                return (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td className="num">{s?.dialogues ?? 0}</td>
                    <td className="num">{s?.scenes ?? 0}</td>
                    <td className="num">{s ? `S#${scenes[s.firstScene - 1]?.label ?? s.firstScene}` : '—'}</td>
                    <td>
                      <textarea
                        rows={2}
                        aria-label={`${name} 설정`}
                        value={project.characters[name]?.description ?? ''}
                        placeholder="나이, 직업, 욕망, 말투…"
                        onChange={(e) => update((p) => ({ characters: { ...p.characters, [name]: { description: e.target.value } } }))}
                      />
                    </td>
                  </tr>
                );
              })}
              {!characterNames.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    아직 대사가 있는 인물이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card span-2">
          <h2>장면 목록</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">장소</th>
                <th scope="col">내/외</th>
                <th scope="col">시간</th>
                <th scope="col" className="num">
                  쪽
                </th>
                <th scope="col" className="num">
                  분량
                </th>
                <th scope="col">인물</th>
              </tr>
            </thead>
            <tbody>
              {scenes.map((s) => (
                <tr key={s.id}>
                  <td className="num">{s.label}</td>
                  <td>
                    <button className="link-btn" onClick={() => go(projectPath(project.id, 'write', s.id))}>
                      {s.parts.location || s.heading || '(제목 없음)'}
                    </button>
                  </td>
                  <td>{s.parts.place}</td>
                  <td>{s.parts.time}</td>
                  <td className="num">{pagination.pageOf.get(s.id) ?? ''}</td>
                  <td className="num">{formatEighths(pagination.sceneEighths.get(s.id) ?? 1)}</td>
                  <td>{s.characters.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card span-2">
          <h2>장소</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">장소</th>
                <th scope="col" className="num">
                  장면 수
                </th>
                <th scope="col" className="num">
                  분량
                </th>
                <th scope="col">시간대</th>
              </tr>
            </thead>
            <tbody>
              {locations.map(([loc, v]) => (
                <tr key={loc}>
                  <th scope="row">{loc}</th>
                  <td className="num">{v.count}</td>
                  <td className="num">{formatEighths(v.eighths)}</td>
                  <td>{[...v.times].join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
