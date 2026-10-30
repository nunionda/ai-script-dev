import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './db';
import { createApp } from './app';
import type { Project } from '../shared/types';

const emptyReview = { quotes: [], sceneCard: {}, antiCliche: [], selfReview: [], audit: [], openIssues: [], changeLog: '', rewrites: 0 };

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

  it('returns 404 for unknown API routes', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});
