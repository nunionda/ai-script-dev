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

export type SceneLink = 'therefore' | 'but' | 'andthen';
export type TurnBy = 'action' | 'revelation';

export interface SceneMeta {
  /** 막 id. 비어 있으면 원고상 앞 장면의 막을 따른다. */
  act?: string;
  synopsis?: string;
  intent?: string;
  color?: string;
  // 장면 카드: 쓰기 전에 선언하는 설계
  pov?: string;
  goal?: string;
  obstacle?: string;
  outcome?: string;
  /** 장면이 시작할 때 걸린 가치 (예: "신뢰 +") */
  valueStart?: string;
  valueEnd?: string;
  turnBy?: TurnBy;
  /** 직전 장면과의 연결어 */
  link?: SceneLink;
  /** 수위·재현 메모 (노출 정도, 시뮬레이션 범위, 카메라 원칙) */
  ratingNote?: string;
  /** 번호 고정 시의 장면 번호 ("41", "41-1") */
  label?: string;
  /** 삭제 장면 — 번호는 남긴다 */
  omitted?: boolean;
}

/** 판정서 항목 (R1, D12 …) */
export interface Ruling {
  id: string;
  code: string;
  text: string;
}

export type TagKind = 'motif' | 'counter' | 'intimacy' | 'note';

/** 원고 요소에 붙이는 태그 분류. counter는 작품 전체 등장 횟수를 센다. */
export interface TagCategory {
  id: string;
  name: string;
  kind: TagKind;
  /** 정확히 이 횟수여야 한다 */
  exact?: number;
  /** 이 횟수를 넘으면 안 된다 */
  max?: number;
}

export type MotifStage = 'setup' | 'variation' | 'payoff';

export interface ElementTag {
  cat: string;
  stage?: MotifStage;
  note?: string;
}

/** 원고 요소에 붙는 표시. 요소 id로 연결한다. */
export interface ElementMark {
  /** 【확정】 — AI가 바꿀 수 없다 */
  locked?: boolean;
  /** 〈극중극〉 — 금지어 예외 */
  play?: boolean;
  tags?: ElementTag[];
}

export interface AuditOptions {
  /** V.O.·내레이션 금지 */
  banVoiceOver: boolean;
  /** 장면 카드(가치 전환·연결어) 필수 */
  requireSceneCard: boolean;
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
  /** 판정서 — AI가 어떤 경우에도 지키는 최우선 규칙 */
  rulings: Ruling[];
  /** 주인공의 '하나의 행동' 한 문장 */
  oneAction: string;
  /** 작품의 하드 규칙 (H1 …) */
  hardRules: Ruling[];
  /** 인물이 말하면 안 되는 주제어 */
  bannedWords: string[];
  tagCategories: TagCategory[];
  elementMarks: Record<string, ElementMark>;
  auditOptions: AuditOptions;
  /** 장면 번호 고정 (추가 장면은 41-1, 삭제 장면은 번호 유지) */
  numberingLocked: boolean;
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

export type DocumentKind = 'synopsis' | 'treatment' | 'scene-log' | 'characters' | 'scene-bank' | 'research' | 'other';

/** 작품 참고 문서 (시놉시스·트리트먼트·취재 노트 …) — AI 문맥 맨 앞에 전문이 들어간다 */
export interface ReferenceDocument {
  id: string;
  projectId: string;
  kind: DocumentKind;
  title: string;
  content: string;
  updatedAt: string;
}

export interface AuditFinding {
  code: string;
  level: 'fail' | 'warn';
  message: string;
  sceneId?: string;
  elementId?: string;
}

export interface ChecklistResult {
  code: string;
  pass: boolean;
  note: string;
}

export type OpenIssueKind = 'ruling' | 'research' | 'consultant' | 'conflict';

export interface OpenIssue {
  kind: OpenIssueKind;
  text: string;
}

/** 수정안을 쓰기 전에 선언한 장면 카드 */
export type SceneCard = Pick<SceneMeta, 'pov' | 'goal' | 'obstacle' | 'outcome' | 'valueStart' | 'valueEnd' | 'turnBy' | 'link' | 'ratingNote'> & {
  setups?: string;
  research?: string;
};

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
  /** 근거로 인용한 판정·규칙·문서 구절 */
  quotes: { source: string; text: string }[];
  sceneCard: SceneCard;
  /** 관객이 예상할 흔한 처리 — 피한 것 */
  antiCliche: string[];
  selfReview: ChecklistResult[];
  /** 코드가 판정한 점검 결과 */
  audit: AuditFinding[];
  openIssues: OpenIssue[];
  changeLog: string;
  /** 자기 검수 후 다시 쓴 횟수 */
  rewrites: number;
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
