import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './db';
import { createApp } from './app';
import type { Project } from '../shared/types';

const emptyReview = { quotes: [], sceneCard: {}, antiCliche: [], selfReview: [], audit: [], openIssues: [], changeLog: '', rewrites: 0, reviews: [] };

let server: Server;
let base = '';
const store = new Store(':memory:');

beforeAll(async () => {
  store.seedIfEmpty();
  server = createApp(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

describe('projects API', () => {
  it('seeds the sample project', async () => {
    const { body } = await call('GET', '/projects');
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe('마지막 상영');
    expect(body[0].sceneCount).toBe(5);
  });

  it('creates, updates with optimistic concurrency, and deletes', async () => {
    const created = await call('POST', '/projects', { title: '새 작품', elements: [{ type: 'scene', text: 'INT. ROOM - DAY' }] });
    expect(created.status).toBe(201);
    const p = created.body as Project;
    expect(p.rev).toBe(1);
    expect(p.elements[0].id).toBeTruthy();

    const ok = await call('PUT', `/projects/${p.id}`, { baseRev: 1, logline: '한 줄 요약' });
    expect(ok.status).toBe(200);
    expect(ok.body.rev).toBe(2);
    expect(ok.body.logline).toBe('한 줄 요약');
    expect(ok.body.title).toBe('새 작품');

    const stale = await call('PUT', `/projects/${p.id}`, { baseRev: 1, logline: '덮어쓰기' });
    expect(stale.status).toBe(409);
    expect(stale.body.current.logline).toBe('한 줄 요약');

    expect((await call('DELETE', `/projects/${p.id}`)).status).toBe(204);
    expect((await call('GET', `/projects/${p.id}`)).status).toBe(404);
  });

  it('rejects malformed elements gracefully', async () => {
    const created = await call('POST', '/projects', { title: '  ', elements: [{ type: 'bogus', text: 3 }, null, { type: 'dialogue', text: '안녕' }] });
    expect(created.body.title).toBe('제목 없음');
    expect(created.body.elements.map((e: { type: string }) => e.type)).toEqual(['action', 'dialogue']);
  });
});

describe('snapshots, comments, proposals', () => {
  it('stores drafts of the script', async () => {
    const summary = (await call('GET', '/projects')).body.find((x: Project) => x.title === '마지막 상영');
    const snap = await call('POST', `/projects/${summary.id}/snapshots`, { label: '', note: '초고' });
    expect(snap.status).toBe(201);
    expect(snap.body.label).toBe('작업본 01');
    const list = await call('GET', `/projects/${summary.id}/snapshots`);
    expect(list.body[0].sceneCount).toBe(5);
    const full = await call('GET', `/snapshots/${snap.body.id}`);
    expect(full.body.elements.length).toBeGreaterThan(10);
  });

  it('adds and resolves scene comments', async () => {
    const summary = (await call('GET', '/projects')).body.find((x: Project) => x.title === '마지막 상영');
    const c = await call('POST', `/projects/${summary.id}/comments`, { sceneId: 'x', author: '민재', role: '공동 작가', text: '좋아요' });
    expect(c.status).toBe(201);
    const r = await call('PATCH', `/comments/${c.body.id}`, { resolved: true });
    expect(r.body.resolved).toBe(true);
    expect((await call('POST', `/projects/${summary.id}/comments`, { sceneId: 'x', text: ' ' })).status).toBe(400);
  });

  it('stores proposal status changes', () => {
    const [summary] = store.listProjects();
    const p = store.createProposal({ projectId: summary.id, sceneId: 's', title: 't', instruction: 'i', rationale: 'r', original: [], revised: [], ...emptyReview });
    expect(p.status).toBe('pending');
    expect(store.setProposalStatus(p.id, 'accepted')!.status).toBe('accepted');
  });

  it('refuses to accept a proposal that rewrites a locked expression', async () => {
    const created = (await call('POST', '/projects', { title: '확정', elements: [{ type: 'scene', text: '내부. 방 - 밤' }, { type: 'dialogue', text: '확정 대사' }] })).body as Project;
    const [scene, line] = created.elements;
    await call('PUT', `/projects/${created.id}`, { elementMarks: { [line.id]: { locked: true } } });
    const bad = store.createProposal({
      projectId: created.id,
      sceneId: scene.id,
      title: 't',
      instruction: '',
      rationale: '',
      original: created.elements,
      revised: [scene, { ...line, text: '바뀐 대사' }],
      ...emptyReview,
    });
    const refused = await call('PATCH', `/proposals/${bad.id}`, { status: 'accepted' });
    expect(refused.status).toBe(409);
    expect((await call('PATCH', `/proposals/${bad.id}`, { status: 'held' })).status).toBe(200);
    const good = store.createProposal({ projectId: created.id, sceneId: scene.id, title: 't', instruction: '', rationale: '', original: created.elements, revised: created.elements, ...emptyReview });
    expect((await call('PATCH', `/proposals/${good.id}`, { status: 'accepted' })).status).toBe(200);
  });

  it('keeps reference documents per project', async () => {
    const [summary] = store.listProjects();
    const created = await call('POST', `/projects/${summary.id}/documents`, { kind: 'research', title: '취재 노트', content: '2011년 요금' });
    expect(created.status).toBe(201);
    const updated = await call('PUT', `/documents/${created.body.id}`, { content: '2011년 요금 [확인]', kind: 'bogus' });
    expect(updated.body.kind).toBe('research');
    expect(updated.body.content).toBe('2011년 요금 [확인]');
    expect((await call('GET', `/projects/${summary.id}/documents`)).body).toHaveLength(1);
    expect((await call('DELETE', `/documents/${created.body.id}`)).status).toBe(204);
  });

  it('migrates legacy decisions into rulings', () => {
    const p = store.createProject({ title: '옛 작품', decisions: ['감정은 행동으로.'] } as never);
    expect(p.rulings).toEqual([{ id: 'legacy-d1', code: 'D1', text: '감정은 행동으로.' }]);
    store.deleteProject(p.id);
  });

  it('validates role reviews and keeps the latest review per role', async () => {
    const [summary] = store.listProjects();
    const p = store.createProposal({ projectId: summary.id, sceneId: 's', title: 't', instruction: '', rationale: '', original: [], revised: [], ...emptyReview });
    expect((await call('POST', `/proposals/${p.id}/reviews`, { role: 'BOGUS' })).status).toBe(400);
    expect((await call('POST', '/proposals/nope/reviews', { role: 'ETH' })).status).toBe(404);
    const review = (risk: 'high' | 'low') => ({ role: 'ETH' as const, verdicts: [], risk, summary: '', suggestions: [], consultantItems: [], createdAt: '' });
    store.addProposalReview(p.id, review('high'));
    const saved = store.addProposalReview(p.id, review('low'))!;
    expect(saved.reviews.map((r) => r.risk)).toEqual(['low']);
    expect((await call('GET', '/projects')).status).toBe(200);
  });

  it('stores the structure audit and refuses empty work before calling AI', async () => {
    const empty = (await call('POST', '/projects', { title: '빈 작품', elements: [] })).body as Project;
    expect((await call('GET', `/projects/${empty.id}/audit/structure`)).body).toBeNull();
    expect((await call('POST', `/projects/${empty.id}/chat/summary`, { sceneId: 'project' })).status).toBe(400);
    store.saveStructureAudit(empty.id, { rows: [], summary: '첫 감사', issues: [], createdAt: '' });
    store.saveStructureAudit(empty.id, { rows: [], summary: '두 번째', issues: [], createdAt: '' });
    expect((await call('GET', `/projects/${empty.id}/audit/structure`)).body.summary).toBe('두 번째');
  });

  it('creates a linked English parallel version', async () => {
    const src = (await call('POST', '/projects', { title: '정본', elements: [{ type: 'scene', text: '내부. 방 - 밤' }], rulings: [{ code: 'R1', text: '규칙' }] })).body as Project;
    const created = await call('POST', `/projects/${src.id}/translations`);
    expect(created.status).toBe(201);
    const en = created.body as Project;
    expect(en.format).toBe('hollywood');
    expect(en.translation?.sourceProjectId).toBe(src.id);
    expect(en.rulings[0].text).toBe('규칙');
    expect((await call('GET', `/projects/${src.id}/translations`)).body.map((p: Project) => p.id)).toEqual([en.id]);
    // 병행본에서 다시 병행본을 만들 수 없다
    expect((await call('POST', `/projects/${en.id}/translations`)).status).toBe(400);
    expect((await call('POST', `/projects/${src.id}/translate-scene`, { sourceSceneId: 'x' })).status).toBe(400);
    expect((await call('POST', `/projects/${en.id}/translate-scene`, { sourceSceneId: 'nope' })).status).toBe(404);
    // 저장해도 연결이 남는다
    const saved = await call('PUT', `/projects/${en.id}`, { translation: { ...en.translation, names: { 세영: 'SEYOUNG' } } });
    expect(saved.body.translation.names).toEqual({ 세영: 'SEYOUNG' });
  });

  it('returns 404 for unknown API routes', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});

describe('session summary guard', () => {
  it('keeps only decisions quoted from the writer', async () => {
    const { checkDecisions } = await import('./agents');
    const out = checkDecisions(
      {
        decisions: [
          { text: '세영은 끝까지 사과하지 않는다.', quote: '세영은 끝까지 사과 안 해' },
          { text: '결말은 열린 결말로 한다.', quote: '열린 결말이 좋겠습니다' },
          { text: '빈 근거', quote: '' },
        ],
        open: ['소품 고증'],
      },
      ['음… 세영은 끝까지 사과 안 해. 그걸로 가자.', '결말은 어떻게 할까?'],
    );
    expect(out.decisions).toEqual(['세영은 끝까지 사과하지 않는다.']);
    expect(out.open).toEqual(['소품 고증', '(작가 확인 필요) 결말은 열린 결말로 한다.', '(작가 확인 필요) 빈 근거']);
  });
});
