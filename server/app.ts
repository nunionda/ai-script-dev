import express, { type NextFunction, type Request, type Response } from 'express';
import { ConflictError, Store } from './db';
import { AiError, aiStatus, generateProposal, generateSceneCard, streamChat, toAiError } from './ai';
import type { ChatScope, ProposalStatus } from '../shared/types';

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createApp(store: Store) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/ai/status', (_req, res) => res.json(aiStatus()));

  // ------------------------------------------------------------ projects
  api.get('/projects', (_req, res) => res.json(store.listProjects()));

  api.post('/projects', (req, res) => {
    res.status(201).json(store.createProject(req.body ?? {}));
  });

  api.get('/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    res.json(p);
  });

  api.put('/projects/:id', (req, res) => {
    const { baseRev, ...patch } = req.body ?? {};
    try {
      const p = store.updateProject(req.params.id, patch, typeof baseRev === 'number' ? baseRev : undefined);
      if (!p) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      res.json(p);
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, current: e.current });
      throw e;
    }
  });

  api.delete('/projects/:id', (req, res) => {
    if (!store.deleteProject(req.params.id)) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    res.status(204).end();
  });

  // ------------------------------------------------------------ snapshots
  api.get('/projects/:id/snapshots', (req, res) => res.json(store.listSnapshots(req.params.id)));
  api.post('/projects/:id/snapshots', (req, res) => {
    const s = store.createSnapshot(req.params.id, str(req.body?.label, 200), str(req.body?.note, 2000));
    if (!s) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    res.status(201).json(s);
  });
  api.get('/snapshots/:sid', (req, res) => {
    const s = store.getSnapshot(req.params.sid);
    if (!s) return res.status(404).json({ error: '작업본을 찾을 수 없습니다.' });
    res.json(s);
  });
  api.delete('/snapshots/:sid', (req, res) => {
    if (!store.deleteSnapshot(req.params.sid)) return res.status(404).json({ error: '작업본을 찾을 수 없습니다.' });
    res.status(204).end();
  });

  // ------------------------------------------------------------ proposals
  api.get('/projects/:id/proposals', (req, res) => res.json(store.listProposals(req.params.id)));

  api.post(
    '/projects/:id/proposals',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      const sceneId = str(req.body?.sceneId, 100);
      const instruction = str(req.body?.instruction, 4000);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const draft = await generateProposal(project, sceneId, instruction, controller.signal);
      const proposal = store.createProposal({ projectId: project.id, sceneId, instruction, ...draft });
      res.status(201).json(proposal);
    }),
  );

  api.patch('/proposals/:pid', (req, res) => {
    const status = req.body?.status as ProposalStatus;
    if (!['pending', 'accepted', 'held', 'rejected'].includes(status)) return res.status(400).json({ error: '잘못된 상태입니다.' });
    const p = store.setProposalStatus(req.params.pid, status);
    if (!p) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
    res.json(p);
  });

  api.delete('/proposals/:pid', (req, res) => {
    if (!store.deleteProposal(req.params.pid)) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
    res.status(204).end();
  });

  // ------------------------------------------------------------ comments
  api.get('/projects/:id/comments', (req, res) => res.json(store.listComments(req.params.id)));
  api.post('/projects/:id/comments', (req, res) => {
    const text = str(req.body?.text, 4000).trim();
    const sceneId = str(req.body?.sceneId, 100);
    if (!text || !sceneId) return res.status(400).json({ error: '의견 내용을 입력해 주세요.' });
    if (!store.getProject(req.params.id)) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    res.status(201).json(
      store.createComment({
        projectId: req.params.id,
        sceneId,
        author: str(req.body?.author, 80).trim() || '익명',
        role: str(req.body?.role, 80),
        text,
      }),
    );
  });
  api.patch('/comments/:cid', (req, res) => {
    const c = store.setCommentResolved(req.params.cid, Boolean(req.body?.resolved));
    if (!c) return res.status(404).json({ error: '의견을 찾을 수 없습니다.' });
    res.json(c);
  });
  api.delete('/comments/:cid', (req, res) => {
    if (!store.deleteComment(req.params.cid)) return res.status(404).json({ error: '의견을 찾을 수 없습니다.' });
    res.status(204).end();
  });

  // ------------------------------------------------------------ AI chat
  api.get('/projects/:id/chat', (req, res) => res.json(store.listChat(req.params.id, str(req.query.sceneId, 100) || 'project')));
  api.delete('/projects/:id/chat', (req, res) => {
    store.clearChat(req.params.id, str(req.query.sceneId, 100) || 'project');
    res.status(204).end();
  });

  /** SSE: event "user" → "delta"* → "done" | "error" */
  api.post(
    '/projects/:id/chat',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      const sceneId = str(req.body?.sceneId, 100) || 'project';
      const scope: ChatScope = req.body?.scope === 'script' ? 'script' : 'scene';
      const content = str(req.body?.content, 8000).trim();
      if (!content) return res.status(400).json({ error: '메시지를 입력해 주세요.' });

      const userMsg = store.addChat({ projectId: project.id, sceneId, role: 'user', author: str(req.body?.author, 80) || '작가', content });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('user', userMsg);

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const text = await streamChat({
          project,
          sceneId,
          scope,
          history: store.listChat(project.id, sceneId),
          signal: controller.signal,
          onText: (delta) => send('delta', { text: delta }),
        });
        const saved = store.addChat({ projectId: project.id, sceneId, role: 'assistant', author: '개발 파트너', content: text });
        send('done', saved);
      } catch (e) {
        if (controller.signal.aborted) return;
        const err = toAiError(e);
        send('error', { error: err.message, status: err.status });
      } finally {
        res.end();
      }
    }),
  );

  api.post(
    '/projects/:id/scene-card',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      res.json(await generateSceneCard(project, str(req.body?.sceneId, 100)));
    }),
  );

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: '없는 API입니다.' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err instanceof AiError ? err : toAiError(err);
    if (e.status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(e.status).json({ error: e.message });
  });

  return app;
}
