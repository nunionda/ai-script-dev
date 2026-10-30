import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AuditFinding,
  ChatMessage,
  ChecklistResult,
  DocumentKind,
  ElementMark,
  OpenIssue,
  ReferenceDocument,
  RoleReview,
  Ruling,
  SceneCard,
  TranslatedScene,
  TranslationLink,
  TagCategory,
  Project,
  ProjectSummary,
  Proposal,
  ProposalStatus,
  SceneComment,
  Snapshot,
  SnapshotSummary,
  StructureAudit,
} from '../shared/types';
import { normalizeElements, uid } from '../shared/screenplay';
import { paginate } from '../shared/pagination';
import { bibleDefaults, sampleProject } from '../shared/sample';

type ProjectData = Omit<Project, 'id' | 'rev' | 'createdAt' | 'updatedAt'>;

const PROJECT_FIELDS: (keyof ProjectData)[] = [
  'title',
  'logline',
  'genre',
  'author',
  'contact',
  'format',
  'status',
  'elements',
  'acts',
  'sceneMeta',
  'characters',
  'rulings',
  'oneAction',
  'hardRules',
  'bannedWords',
  'tagCategories',
  'elementMarks',
  'auditOptions',
  'numberingLocked',
  'openQuestions',
  'translation',
];

export class ConflictError extends Error {
  constructor(public current: Project) {
    super('다른 곳에서 먼저 저장된 변경이 있습니다.');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeRulings(v: unknown, prefix: string): Ruling[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((r, i) => ({ id: text(r.id, 40) || uid(prefix.toLowerCase()), code: text(r.code, 20).trim() || `${prefix}${i + 1}`, text: text(r.text) }));
}

function sanitizeTagCategories(v: unknown): TagCategory[] {
  if (!Array.isArray(v)) return [];
  const kinds = ['motif', 'counter', 'intimacy', 'note'];
  const count = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : undefined);
  return v.filter(isObj).map((c) => ({
    id: text(c.id, 40) || uid('t'),
    name: text(c.name, 80),
    kind: (kinds.includes(c.kind as string) ? c.kind : 'note') as TagCategory['kind'],
    exact: count(c.exact),
    max: count(c.max),
  }));
}

function sanitizeMarks(v: unknown): Record<string, ElementMark> {
  if (!isObj(v)) return {};
  const out: Record<string, ElementMark> = {};
  const stages = ['setup', 'variation', 'payoff'];
  for (const [id, raw] of Object.entries(v)) {
    if (!isObj(raw)) continue;
    const m: ElementMark = {};
    if (raw.locked === true) m.locked = true;
    if (raw.play === true) m.play = true;
    if (Array.isArray(raw.tags)) {
      const tags = raw.tags
        .filter(isObj)
        .filter((t) => typeof t.cat === 'string' && t.cat)
        .map((t) => ({
          cat: t.cat as string,
          ...(stages.includes(t.stage as string) ? { stage: t.stage as 'setup' } : {}),
          ...(typeof t.note === 'string' && t.note ? { note: t.note.slice(0, 500) } : {}),
        }));
      if (tags.length) m.tags = tags;
    }
    if (m.locked || m.play || m.tags) out[id] = m;
  }
  return out;
}

function sanitizeTranslation(v: unknown): TranslationLink | null {
  if (!isObj(v) || typeof v.sourceProjectId !== 'string' || !v.sourceProjectId) return null;
  const scenes: Record<string, TranslatedScene> = {};
  for (const [id, raw] of Object.entries(isObj(v.scenes) ? v.scenes : {})) {
    if (!isObj(raw) || typeof raw.targetSceneId !== 'string') continue;
    scenes[id] = {
      targetSceneId: raw.targetSceneId,
      sourceHash: text(raw.sourceHash, 40),
      targetHash: text(raw.targetHash, 40),
      translatedAt: text(raw.translatedAt, 40),
      losses: (Array.isArray(raw.losses) ? raw.losses : []).filter(isObj).map((l) => ({
        original: text(l.original, 2000),
        translation: text(l.translation, 2000),
        loss: text(l.loss, 2000),
        compensation: text(l.compensation, 2000),
      })),
    };
  }
  const names: Record<string, string> = {};
  for (const [ko, en] of Object.entries(isObj(v.names) ? v.names : {})) if (typeof en === 'string' && en.trim()) names[ko.slice(0, 80)] = en.slice(0, 80);
  return { sourceProjectId: v.sourceProjectId, language: 'en', scenes, names };
}

export function sanitizeProjectData(input: Partial<ProjectData> & { decisions?: unknown }, base?: ProjectData): ProjectData {
  const b: ProjectData = base ?? {
    title: '제목 없음',
    logline: '',
    genre: '',
    author: '',
    contact: '',
    format: 'korean',
    status: '',
    elements: [],
    acts: [],
    sceneMeta: {},
    characters: {},
    ...bibleDefaults(),
    openQuestions: [],
    translation: null,
  };
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  const strArr = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d);
  const obj = <T>(v: unknown, d: T): T => (isObj(v) ? (v as T) : d);
  // 예전 "함께 정한 방향"(decisions)은 판정서 D1… 로 옮긴다
  const legacyRulings =
    input.rulings === undefined && Array.isArray(input.decisions)
      ? strArr(input.decisions, []).map((t, i) => ({ id: `legacy-d${i + 1}`, code: `D${i + 1}`, text: t }))
      : undefined;
  const audit = isObj(input.auditOptions) ? input.auditOptions : undefined;
  return {
    title: str(input.title, b.title).trim() || '제목 없음',
    logline: str(input.logline, b.logline),
    genre: str(input.genre, b.genre),
    author: str(input.author, b.author),
    contact: str(input.contact, b.contact),
    format: input.format === 'hollywood' || input.format === 'korean' ? input.format : b.format,
    status: str(input.status, b.status),
    elements: input.elements !== undefined ? normalizeElements(input.elements) : b.elements,
    acts: Array.isArray(input.acts)
      ? input.acts.filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, title: str(a.title, '') }))
      : b.acts,
    sceneMeta: obj(input.sceneMeta, b.sceneMeta),
    characters: obj(input.characters, b.characters),
    rulings: legacyRulings ?? (input.rulings !== undefined ? sanitizeRulings(input.rulings, 'R') : b.rulings),
    oneAction: str(input.oneAction, b.oneAction),
    hardRules: input.hardRules !== undefined ? sanitizeRulings(input.hardRules, 'H') : b.hardRules,
    bannedWords: input.bannedWords !== undefined ? strArr(input.bannedWords, []).map((w) => w.trim()).filter(Boolean) : b.bannedWords,
    tagCategories: input.tagCategories !== undefined ? sanitizeTagCategories(input.tagCategories) : b.tagCategories,
    elementMarks: input.elementMarks !== undefined ? sanitizeMarks(input.elementMarks) : b.elementMarks,
    auditOptions: audit
      ? { banVoiceOver: audit.banVoiceOver === true, requireSceneCard: audit.requireSceneCard === true }
      : b.auditOptions,
    numberingLocked: typeof input.numberingLocked === 'boolean' ? input.numberingLocked : b.numberingLocked,
    openQuestions: strArr(input.openQuestions, b.openQuestions),
    translation: input.translation !== undefined ? sanitizeTranslation(input.translation) : b.translation,
  };
}

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        elements TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL,
        author TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL,
        role TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project_id);
      CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id);
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_project_scene ON chat(project_id, scene_id);
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE TABLE IF NOT EXISTS structure_audits (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
    `);
  }

  seedIfEmpty() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    if (row.n === 0) this.createProject(sampleProject());
  }

  // ------------------------------------------------------------ projects

  private rowToProject(row: Record<string, unknown>): Project {
    const data = sanitizeProjectData(JSON.parse(row.data as string));
    return {
      id: row.id as string,
      ...data,
      rev: row.rev as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => {
      const p = this.rowToProject(r);
      return {
        id: p.id,
        title: p.title,
        logline: p.logline,
        genre: p.genre,
        status: p.status,
        sceneCount: p.elements.filter((e) => e.type === 'scene').length,
        pageCount: paginate(p.elements).pageCount,
        updatedAt: p.updatedAt,
      };
    });
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : null;
  }

  createProject(input: Partial<ProjectData>): Project {
    const id = uid('p');
    const now = new Date().toISOString();
    const data = sanitizeProjectData(input);
    this.db.prepare('INSERT INTO projects (id, data, rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(id, JSON.stringify(data), now, now);
    return this.getProject(id)!;
  }

  /** baseRev가 현재 rev와 다르면 ConflictError */
  updateProject(id: string, patch: Partial<ProjectData>, baseRev?: number): Project | null {
    const current = this.getProject(id);
    if (!current) return null;
    if (baseRev !== undefined && baseRev !== current.rev) throw new ConflictError(current);
    const { id: _id, rev: _rev, createdAt: _c, updatedAt: _u, ...base } = current;
    const picked: Partial<ProjectData> = {};
    for (const k of PROJECT_FIELDS) if (k in patch) (picked as Record<string, unknown>)[k] = patch[k];
    const data = sanitizeProjectData(picked, base);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE projects SET data = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ snapshots

  listSnapshots(projectId: string): SnapshotSummary[] {
    const rows = this.db.prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => {
      const elements = normalizeElements(JSON.parse(r.elements as string));
      return {
        id: r.id as string,
        projectId,
        label: r.label as string,
        note: r.note as string,
        createdAt: r.created_at as string,
        sceneCount: elements.filter((e) => e.type === 'scene').length,
        pageCount: paginate(elements).pageCount,
      };
    });
  }

  getSnapshot(id: string): Snapshot | null {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      label: r.label as string,
      note: r.note as string,
      elements: normalizeElements(JSON.parse(r.elements as string)),
      createdAt: r.created_at as string,
    };
  }

  createSnapshot(projectId: string, label: string, note: string): Snapshot | null {
    const p = this.getProject(projectId);
    if (!p) return null;
    const id = uid('s');
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE project_id = ?').get(projectId) as { n: number }).n;
    const finalLabel = label.trim() || `작업본 ${String(count + 1).padStart(2, '0')}`;
    this.db
      .prepare('INSERT INTO snapshots (id, project_id, label, note, elements, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, finalLabel, note, JSON.stringify(p.elements), new Date().toISOString());
    return this.getSnapshot(id);
  }

  deleteSnapshot(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ proposals

  private rowToProposal(r: Record<string, unknown>): Proposal {
    const data = JSON.parse(r.data as string);
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      sceneId: r.scene_id as string,
      status: r.status as ProposalStatus,
      title: data.title ?? '',
      instruction: data.instruction ?? '',
      rationale: data.rationale ?? '',
      original: normalizeElements(data.original),
      revised: normalizeElements(data.revised),
      quotes: Array.isArray(data.quotes) ? data.quotes : [],
      sceneCard: (isObj(data.sceneCard) ? data.sceneCard : {}) as SceneCard,
      antiCliche: Array.isArray(data.antiCliche) ? data.antiCliche : [],
      selfReview: (Array.isArray(data.selfReview) ? data.selfReview : []) as ChecklistResult[],
      audit: (Array.isArray(data.audit) ? data.audit : []) as AuditFinding[],
      openIssues: (Array.isArray(data.openIssues) ? data.openIssues : []) as OpenIssue[],
      changeLog: typeof data.changeLog === 'string' ? data.changeLog : '',
      rewrites: typeof data.rewrites === 'number' ? data.rewrites : 0,
      reviews: (Array.isArray(data.reviews) ? data.reviews : []) as RoleReview[],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listProposals(projectId: string): Proposal[] {
    const rows = this.db.prepare('SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToProposal(r));
  }

  getProposal(id: string): Proposal | null {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToProposal(r) : null;
  }

  createProposal(p: Omit<Proposal, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Proposal {
    const id = uid('r');
    const now = new Date().toISOString();
    const { projectId: _p, sceneId: _s, ...data } = p;
    this.db
      .prepare('INSERT INTO proposals (id, project_id, scene_id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.projectId, p.sceneId, 'pending', JSON.stringify(data), now, now);
    return this.getProposal(id)!;
  }

  setProposalStatus(id: string, status: ProposalStatus): Proposal | null {
    this.db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return this.getProposal(id);
  }

  /** 역할별 최신 검수 하나만 남긴다 */
  addProposalReview(id: string, review: RoleReview): Proposal | null {
    const r = this.db.prepare('SELECT data FROM proposals WHERE id = ?').get(id) as { data: string } | undefined;
    if (!r) return null;
    const data = JSON.parse(r.data);
    const reviews = (Array.isArray(data.reviews) ? data.reviews : []) as RoleReview[];
    data.reviews = [...reviews.filter((x) => x.role !== review.role), review];
    this.db.prepare('UPDATE proposals SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), new Date().toISOString(), id);
    return this.getProposal(id);
  }

  deleteProposal(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM proposals WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ structure audit

  getStructureAudit(projectId: string): StructureAudit | null {
    const r = this.db.prepare('SELECT data FROM structure_audits WHERE project_id = ?').get(projectId) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as StructureAudit) : null;
  }

  saveStructureAudit(projectId: string, audit: StructureAudit): StructureAudit {
    this.db
      .prepare('INSERT INTO structure_audits (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data')
      .run(projectId, JSON.stringify(audit));
    return audit;
  }

  // ------------------------------------------------------------ documents

  private rowToDocument(r: Record<string, unknown>): ReferenceDocument {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      kind: r.kind as DocumentKind,
      title: r.title as string,
      content: r.content as string,
      updatedAt: r.updated_at as string,
    };
  }

  listDocuments(projectId: string): ReferenceDocument[] {
    const rows = this.db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY position, updated_at').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDocument(r));
  }

  getDocument(id: string): ReferenceDocument | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToDocument(r) : null;
  }

  createDocument(d: Pick<ReferenceDocument, 'projectId' | 'kind' | 'title' | 'content'>): ReferenceDocument {
    const id = uid('f');
    const position = (this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE project_id = ?').get(d.projectId) as { n: number }).n;
    this.db
      .prepare('INSERT INTO documents (id, project_id, kind, title, content, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.projectId, d.kind, d.title, d.content, position, new Date().toISOString());
    return this.getDocument(id)!;
  }

  updateDocument(id: string, patch: Partial<Pick<ReferenceDocument, 'kind' | 'title' | 'content'>>): ReferenceDocument | null {
    const cur = this.getDocument(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE documents SET kind = ?, title = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(next.kind, next.title, next.content, new Date().toISOString(), id);
    return this.getDocument(id);
  }

  deleteDocument(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ comments

  private rowToComment(r: Record<string, unknown>): SceneComment {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      sceneId: r.scene_id as string,
      author: r.author as string,
      role: r.role as string,
      text: r.text as string,
      resolved: Boolean(r.resolved),
      createdAt: r.created_at as string,
    };
  }

  listComments(projectId: string): SceneComment[] {
    const rows = this.db.prepare('SELECT * FROM comments WHERE project_id = ? ORDER BY created_at').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToComment(r));
  }

  createComment(c: Pick<SceneComment, 'projectId' | 'sceneId' | 'author' | 'role' | 'text'>): SceneComment {
    const id = uid('c');
    this.db
      .prepare('INSERT INTO comments (id, project_id, scene_id, author, role, text, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, c.projectId, c.sceneId, c.author, c.role, c.text, new Date().toISOString());
    return this.rowToComment(this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown>);
  }

  setCommentResolved(id: string, resolved: boolean): SceneComment | null {
    this.db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
    const r = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToComment(r) : null;
  }

  deleteComment(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM comments WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ chat

  listChat(projectId: string, sceneId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM chat WHERE project_id = ? AND scene_id = ? ORDER BY created_at, rowid').all(projectId, sceneId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      sceneId: r.scene_id as string,
      role: r.role as 'user' | 'assistant',
      author: r.author as string,
      content: r.content as string,
      createdAt: r.created_at as string,
    }));
  }

  addChat(m: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const msg: ChatMessage = { ...m, id: uid('m'), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO chat (id, project_id, scene_id, role, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.projectId, msg.sceneId, msg.role, msg.author, msg.content, msg.createdAt);
    return msg;
  }

  clearChat(projectId: string, sceneId: string) {
    this.db.prepare('DELETE FROM chat WHERE project_id = ? AND scene_id = ?').run(projectId, sceneId);
  }
}
