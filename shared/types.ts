export const ELEMENT_TYPES = [
  'scene',
  'action',
  'character',
  'parenthetical',
  'dialogue',
  'transition',
  'shot',
  'general',
] as const;

export type ElementType = (typeof ELEMENT_TYPES)[number];

export interface ScriptElement {
  id: string;
  type: ElementType;
  text: string;
}

export interface Act {
  id: string;
  title: string;
}

export interface SceneMeta {
  /** 막 id. 비어 있으면 원고상 앞 장면의 막을 따른다. */
  act?: string;
  synopsis?: string;
  intent?: string;
  color?: string;
}

export interface CharacterNote {
  description: string;
}

export type ScriptFormat = 'korean' | 'hollywood';

export interface Project {
  id: string;
  title: string;
  logline: string;
  genre: string;
  author: string;
  contact: string;
  format: ScriptFormat;
  status: string;
  elements: ScriptElement[];
  acts: Act[];
  sceneMeta: Record<string, SceneMeta>;
  characters: Record<string, CharacterNote>;
  /** 팀이 함께 정한 방향 (홈 화면 "함께 정한 방향") */
  decisions: string[];
  /** 결말 등 아직 열어 둔 질문 */
  openQuestions: string[];
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  logline: string;
  genre: string;
  status: string;
  sceneCount: number;
  pageCount: number;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  projectId: string;
  label: string;
  note: string;
  elements: ScriptElement[];
  createdAt: string;
}

export type SnapshotSummary = Omit<Snapshot, 'elements'> & { sceneCount: number; pageCount: number };

export type ProposalStatus = 'pending' | 'accepted' | 'held' | 'rejected';

export interface Proposal {
  id: string;
  projectId: string;
  sceneId: string;
  title: string;
  instruction: string;
  rationale: string;
  original: ScriptElement[];
  revised: ScriptElement[];
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SceneComment {
  id: string;
  projectId: string;
  sceneId: string;
  author: string;
  role: string;
  text: string;
  resolved: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  sceneId: string;
  role: 'user' | 'assistant';
  author: string;
  content: string;
  createdAt: string;
}

export type ChatScope = 'scene' | 'script';
