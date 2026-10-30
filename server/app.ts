import express, { type NextFunction, type Request, type Response } from 'express';
import { ConflictError, Store } from './db';
import { AiError, aiStatus, generateProposal, generateSceneCard, streamChat, toAiError } from './ai';
import { auditStructure, reviewProposal, summarizeChat, translateScene } from './agents';
import { REVIEW_ROLES, type ChatScope, type DocumentKind, type ProposalStatus, type ReviewRole } from '../shared/types';
import { el, getScenes, sceneElements } from '../shared/screenplay';
import { hollywoodLabel, sceneHash } from '../shared/translation';
import { lockedChanged } from '../shared/audit';
import { authConfigFromEnv, createAuth, type AuthConfig } from './auth';

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createApp(store: Store, authConfig: AuthConfig = authConfigFromEnv()) {
  const app = express();
  app.disable('x-powered-by');
  // Enable only for a known single reverse proxy, such as Render.
  if (process.env.FRAME_TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(express.json({ limit: '20mb' }));
  app.use(createAuth(store, authConfig));
  app.get('/api/auth/me', (_req, res) => res.json({ required: false, user: null }));
  app.use('/api/auth', (_req, res) => res.status(404).json({ error: '없는 API입니다.' }));

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
      const draft = await generateProposal(project, store.listDocuments(project.id), sceneId, instruction, controller.signal);
      const proposal = store.createProposal({ projectId: project.id, sceneId, instruction, ...draft, reviews: [] });
      res.status(201).json(proposal);
    }),
  );

  api.patch('/proposals/:pid', (req, res) => {
    const status = req.body?.status as ProposalStatus;
    if (!['pending', 'accepted', 'held', 'rejected'].includes(status)) return res.status(400).json({ error: '잘못된 상태입니다.' });
    const current = store.getProposal(req.params.pid);
    if (!current) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
    if (status === 'accepted') {
      // 【확정】 표현을 바꾼 수정안은 채택할 수 없다
      const project = store.getProject(current.projectId);
      const original = project ? sceneElements(project.elements, current.sceneId) : [];
      if (project && lockedChanged(original.length ? original : current.original, current.revised, project.elementMarks).length) {
        return res.status(409).json({ error: '이 수정안은 작가 확정 표현을 바꿉니다. 확정을 풀거나 수정안을 다시 받아 주세요.' });
      }
    }
    const p = store.setProposalStatus(req.params.pid, status);
    if (!p) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
    res.json(p);
  });

  /** 역할 검수: 같은 문서로 새로 호출해 판정만 받는다 */
  api.post(
    '/proposals/:pid/reviews',
    wrap(async (req, res) => {
      const role = req.body?.role as ReviewRole;
      if (!REVIEW_ROLES.includes(role)) return res.status(400).json({ error: '알 수 없는 검수 역할입니다.' });
      const proposal = store.getProposal(req.params.pid);
      if (!proposal) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
      const project = store.getProject(proposal.projectId);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const review = await reviewProposal(project, store.listDocuments(project.id), proposal, role, controller.signal);
      res.status(201).json(store.addProposalReview(proposal.id, review));
    }),
  );

  api.delete('/proposals/:pid', (req, res) => {
    if (!store.deleteProposal(req.params.pid)) return res.status(404).json({ error: '수정안을 찾을 수 없습니다.' });
    res.status(204).end();
  });

  // ------------------------------------------------------------ documents
  const DOC_KINDS: DocumentKind[] = ['synopsis', 'treatment', 'scene-log', 'characters', 'scene-bank', 'research', 'other'];
  const docKind = (v: unknown): DocumentKind | undefined => (DOC_KINDS.includes(v as DocumentKind) ? (v as DocumentKind) : undefined);

  api.get('/projects/:id/documents', (req, res) => res.json(store.listDocuments(req.params.id)));
  api.post('/projects/:id/documents', (req, res) => {
    if (!store.getProject(req.params.id)) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    res.status(201).json(
      store.createDocument({
        projectId: req.params.id,
        kind: docKind(req.body?.kind) ?? 'other',
        title: str(req.body?.title, 200).trim() || '제목 없는 문서',
        content: str(req.body?.content, 2_000_000),
      }),
    );
  });
  api.put('/documents/:did', (req, res) => {
    const patch: Parameters<Store['updateDocument']>[1] = {};
    if (docKind(req.body?.kind)) patch.kind = docKind(req.body.kind);
    if (typeof req.body?.title === 'string') patch.title = str(req.body.title, 200).trim() || '제목 없는 문서';
    if (typeof req.body?.content === 'string') patch.content = str(req.body.content, 2_000_000);
    const d = store.updateDocument(req.params.did, patch);
    if (!d) return res.status(404).json({ error: '문서를 찾을 수 없습니다.' });
    res.json(d);
  });
  api.delete('/documents/:did', (req, res) => {
    if (!store.deleteDocument(req.params.did)) return res.status(404).json({ error: '문서를 찾을 수 없습니다.' });
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
          documents: store.listDocuments(project.id),
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
      res.json(await generateSceneCard(project, store.listDocuments(project.id), str(req.body?.sceneId, 100)));
    }),
  );

  // ------------------------------------------------------------ writers' room
  api.get('/projects/:id/audit/structure', (req, res) => res.json(store.getStructureAudit(req.params.id)));
  api.post(
    '/projects/:id/audit/structure',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const audit = await auditStructure(project, store.listDocuments(project.id), controller.signal);
      res.status(201).json(store.saveStructureAudit(project.id, audit));
    }),
  );

  api.post(
    '/projects/:id/chat/summary',
    wrap(async (req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      const sceneId = str(req.body?.sceneId, 100) || 'project';
      res.json(await summarizeChat(project, store.listDocuments(project.id), store.listChat(project.id, sceneId)));
    }),
  );

  // ------------------------------------------------------------ English parallel version
  /** 정본(:id)에 연결된 영문 병행본 목록 */
  api.get('/projects/:id/translations', (req, res) => {
    const linked = store
      .listProjects()
      .filter((s) => s.id !== req.params.id && store.getProject(s.id)?.translation?.sourceProjectId === req.params.id);
    res.json(linked);
  });

  /** 정본(:id)에서 빈 영문 병행본을 만든다. 판정서·규칙·태그 분류는 같이 가져가고, 원고는 장면별로 번역한다. */
  api.post('/projects/:id/translations', (req, res) => {
    const src = store.getProject(req.params.id);
    if (!src) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
    if (src.translation) return res.status(400).json({ error: '병행본에서 다시 병행본을 만들 수 없습니다. 한국어 정본에서 만들어 주세요.' });
    const created = store.createProject({
      title: `${src.title} (English)`,
      genre: src.genre,
      author: src.author,
      contact: src.contact,
      format: 'hollywood',
      status: '영문 병행본',
      elements: [el('scene', '')],
      acts: src.acts,
      rulings: src.rulings,
      oneAction: src.oneAction,
      hardRules: src.hardRules,
      tagCategories: src.tagCategories,
      auditOptions: src.auditOptions,
      // 정본과 같은 장면 번호를 쓴다
      numberingLocked: true,
      translation: { sourceProjectId: src.id, language: 'en', scenes: {}, names: {} },
    });
    res.status(201).json(created);
  });

  /** 병행본(:id)에 넣을 장면 번역. 원고 반영은 작가 화면에서 한다 (저장 rev 충돌을 피하려고). */
  api.post(
    '/projects/:id/translate-scene',
    wrap(async (req, res) => {
      const target = store.getProject(req.params.id);
      if (!target) return res.status(404).json({ error: '작품을 찾을 수 없습니다.' });
      if (!target.translation) return res.status(400).json({ error: '영문 병행본이 아닙니다.' });
      const source = store.getProject(target.translation.sourceProjectId);
      if (!source) return res.status(404).json({ error: '한국어 정본을 찾을 수 없습니다.' });
      const sourceSceneId = str(req.body?.sourceSceneId, 100);
      const scene = getScenes(source).find((s) => s.id === sourceSceneId);
      if (!scene) return res.status(404).json({ error: '정본에서 장면을 찾을 수 없습니다.' });
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const names = { ...target.translation.names, ...(req.body?.names && typeof req.body.names === 'object' ? req.body.names : {}) };
      const result = await translateScene(source, store.listDocuments(source.id), sourceSceneId, names, controller.signal);
      res.json({
        ...result,
        sourceHash: sceneHash(sceneElements(source.elements, sourceSceneId)),
        label: hollywoodLabel(scene.label),
        act: scene.actId,
      });
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
