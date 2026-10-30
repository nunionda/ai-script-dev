import type {
  ChatMessage,
  ChatScope,
  ChatSummary,
  Project,
  ProjectSummary,
  Proposal,
  ProposalStatus,
  ReferenceDocument,
  ReviewRole,
  SceneComment,
  SceneMeta,
  Snapshot,
  SnapshotSummary,
  StructureAudit,
  TranslationLoss,
  ScriptElement,
} from '../shared/types';

export interface SceneTranslation {
  elements: ScriptElement[];
  losses: TranslationLoss[];
  names: Record<string, string>;
  sourceHash: string;
  label: string;
  act: string;
}

export type GeneratedCard = Required<Pick<SceneMeta, 'synopsis' | 'intent' | 'pov' | 'goal' | 'obstacle' | 'outcome' | 'valueStart' | 'valueEnd' | 'turnBy' | 'link'>>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, '서버에 연결할 수 없습니다.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `요청 실패 (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export type ProjectPatch = Partial<Omit<Project, 'id' | 'rev' | 'createdAt' | 'updatedAt'>>;

export const api = {
  aiStatus: () => request<{ configured: boolean; model: string }>('GET', '/ai/status'),

  listProjects: () => request<ProjectSummary[]>('GET', '/projects'),
  getProject: (id: string) => request<Project>('GET', `/projects/${id}`),
  createProject: (data: ProjectPatch) => request<Project>('POST', '/projects', data),
  saveProject: (id: string, data: ProjectPatch, baseRev?: number, keepalive = false) =>
    request<Project>('PUT', `/projects/${id}`, { ...data, baseRev }, { keepalive }),
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${id}`),

  listSnapshots: (id: string) => request<SnapshotSummary[]>('GET', `/projects/${id}/snapshots`),
  getSnapshot: (sid: string) => request<Snapshot>('GET', `/snapshots/${sid}`),
  createSnapshot: (id: string, label: string, note: string) => request<Snapshot>('POST', `/projects/${id}/snapshots`, { label, note }),
  deleteSnapshot: (sid: string) => request<void>('DELETE', `/snapshots/${sid}`),

  listProposals: (id: string) => request<Proposal[]>('GET', `/projects/${id}/proposals`),
  createProposal: (id: string, sceneId: string, instruction: string) => request<Proposal>('POST', `/projects/${id}/proposals`, { sceneId, instruction }),
  setProposalStatus: (pid: string, status: ProposalStatus) => request<Proposal>('PATCH', `/proposals/${pid}`, { status }),
  deleteProposal: (pid: string) => request<void>('DELETE', `/proposals/${pid}`),
  reviewProposal: (pid: string, role: ReviewRole) => request<Proposal>('POST', `/proposals/${pid}/reviews`, { role }),

  listTranslations: (id: string) => request<ProjectSummary[]>('GET', `/projects/${id}/translations`),
  createTranslation: (id: string) => request<Project>('POST', `/projects/${id}/translations`),
  translateScene: (id: string, sourceSceneId: string, names: Record<string, string>) =>
    request<SceneTranslation>('POST', `/projects/${id}/translate-scene`, { sourceSceneId, names }),

  getStructureAudit: (id: string) => request<StructureAudit | null>('GET', `/projects/${id}/audit/structure`),
  runStructureAudit: (id: string) => request<StructureAudit>('POST', `/projects/${id}/audit/structure`),
  summarizeChat: (id: string, sceneId: string) => request<ChatSummary>('POST', `/projects/${id}/chat/summary`, { sceneId }),

  listComments: (id: string) => request<SceneComment[]>('GET', `/projects/${id}/comments`),
  addComment: (id: string, c: { sceneId: string; author: string; role: string; text: string }) => request<SceneComment>('POST', `/projects/${id}/comments`, c),
  resolveComment: (cid: string, resolved: boolean) => request<SceneComment>('PATCH', `/comments/${cid}`, { resolved }),
  deleteComment: (cid: string) => request<void>('DELETE', `/comments/${cid}`),

  listChat: (id: string, sceneId: string) => request<ChatMessage[]>('GET', `/projects/${id}/chat?sceneId=${encodeURIComponent(sceneId)}`),
  clearChat: (id: string, sceneId: string) => request<void>('DELETE', `/projects/${id}/chat?sceneId=${encodeURIComponent(sceneId)}`),
  sceneCard: (id: string, sceneId: string) => request<GeneratedCard>('POST', `/projects/${id}/scene-card`, { sceneId }),

  listDocuments: (id: string) => request<ReferenceDocument[]>('GET', `/projects/${id}/documents`),
  createDocument: (id: string, d: Pick<ReferenceDocument, 'kind' | 'title' | 'content'>) => request<ReferenceDocument>('POST', `/projects/${id}/documents`, d),
  updateDocument: (did: string, d: Partial<Pick<ReferenceDocument, 'kind' | 'title' | 'content'>>) => request<ReferenceDocument>('PUT', `/documents/${did}`, d),
  deleteDocument: (did: string) => request<void>('DELETE', `/documents/${did}`),
};

export interface ChatHandlers {
  onUser: (m: ChatMessage) => void;
  onDelta: (text: string) => void;
  onDone: (m: ChatMessage) => void;
  onError: (message: string) => void;
}

/** SSE 응답을 읽어 이벤트별로 처리한다. */
export async function sendChat(
  projectId: string,
  body: { sceneId: string; scope: ChatScope; content: string; author: string },
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return;
    handlers.onError('서버에 연결할 수 없습니다.');
    return;
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    handlers.onError(data?.error ?? `요청 실패 (${res.status})`);
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = chunk.match(/^event: (.*)$/m)?.[1];
        const data = chunk.match(/^data: (.*)$/m)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === 'user') handlers.onUser(payload);
        else if (event === 'delta') handlers.onDelta(payload.text);
        else if (event === 'done') {
          finished = true;
          handlers.onDone(payload);
        } else if (event === 'error') {
          finished = true;
          handlers.onError(payload.error);
        }
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!finished && !signal.aborted) handlers.onError('응답이 중간에 끊겼습니다.');
}
