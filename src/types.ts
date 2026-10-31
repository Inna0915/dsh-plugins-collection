export type Column = 'todo' | 'doing' | 'review' | 'done';
export interface Profile {
  id: string;
  name: string;
  host: string;
  browseHost: string;
  projectKeys: string[];
  jql: string;
  storyPointsField: string;
  dueDateField: string;
  sprintField: string;
  workspace: string;
  agentPreset: string;
  allowWrites: boolean;
  credentialStore: 'windows-dpapi' | 'environment';
  statusColumns: Record<string, Column>;
  developmentStatuses: string[];
}
export interface Auth {
  username?: string;
  secret: string;
  kind: 'basic' | 'bearer';
}
export interface JiraUser {
  name?: string;
  key?: string;
  accountId?: string;
  displayName: string;
  active: boolean;
}
export interface Sprint {
  id: number;
  name: string;
  state: string;
  board: string;
  project: string;
}
export interface CreateIssueInput {
  project?: string;
  issueType?: string;
  summary?: string;
  description?: string;
  assignee?: string;
  sprint?: string;
  fields?: Record<string, unknown>;
}
export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string;
  thumbnail?: string;
}
export interface Comment {
  id: string;
  author: string;
  created: string;
  body: string;
}
export interface Issue {
  id: string;
  key: string;
  project: string;
  summary: string;
  type: string;
  status: { id: string; name: string; category: string };
  column: Column;
  priority: string;
  assignee: string;
  assigneeId: string;
  reporter: string;
  created: string;
  updated: string;
  dueDate: string;
  resolvedAt: string;
  resolution: string;
  storyPoints: number | null;
  sprint: string;
  sprintState: string;
  description: string;
  descriptionFormat: 'html' | 'wiki';
  attachments: Attachment[];
  comments: Comment[];
  links: Array<{ key: string; summary: string; relation: string }>;
  url: string;
  warnings: string[];
}
export interface JiraField {
  name: string;
  required: boolean;
  schema?: { type?: string; items?: string; system?: string };
  allowedValues?: Array<{ id?: string; name?: string; value?: string; displayName?: string }>;
}
export interface Transition {
  id: string;
  name: string;
  to: { id: string; name: string };
  fields: Record<string, JiraField>;
}
export interface TransitionContext {
  issue: Issue;
  transitions: Transition[];
}
export interface SearchResult {
  issues: Issue[];
  total: number;
  complete: boolean;
  fetchedAt: string;
  jql: string;
}
export interface AssetRecord {
  issueKey: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  path?: string;
  source: string;
  status: 'downloaded' | 'failed' | 'omitted';
  error?: string;
}
export interface TaskPackage {
  schemaVersion: 1;
  id: string;
  profile: string;
  createdAt: string;
  directory: string;
  indexPath: string;
  manifestPath: string;
  keys: string[];
  assets: AssetRecord[];
  issues: Array<{
    key: string;
    id: string;
    updated: string;
    path: string;
    summary: string;
    statusId: string;
  }>;
  errors: Array<{ key: string; error: string }>;
  instruction: string;
  markdown: string;
}
export interface ComposerDraft {
  text: string;
  images: Array<{ name: string; mimeType: string; data: string }>;
  warnings: string[];
}
export interface History {
  id: string;
  created: string;
  author?: { name?: string; displayName?: string };
  items: Array<{
    field: string;
    from: string | null;
    fromString: string | null;
    to: string | null;
    toString: string | null;
  }>;
}
export interface RunRecord {
  id: string;
  profile: string;
  keys: string[];
  sessionId?: string;
  sessionReady?: boolean;
  fingerprint?: string;
  packageId: string;
  state: 'prepared' | 'delivered' | 'delivery-unknown' | 'failed';
  createdAt: string;
  requestId: string;
  error?: string;
}
export interface TaskResult {
  key: string;
  summary: string;
  verification: string;
  artifacts?: string[];
  remaining?: string;
  expectedUpdated?: string;
  suggestedTransition?: string;
}
