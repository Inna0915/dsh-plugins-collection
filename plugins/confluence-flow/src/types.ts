export interface Auth {
  kind: "basic" | "bearer";
  username?: string;
  secret: string;
}
export interface Profile {
  id: string;
  name: string;
  host: string;
  rootPageIds: string[];
  spaceKey: string;
  targets: Record<string, string>;
  allowWrites: boolean;
  credentialStore: "windows-dpapi" | "environment";
}
export interface Page {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  url: string;
  parentId?: string;
  storage: string;
  updated?: string;
}
/** 页面版本摘要；modifierKey 为最后修改人的用户名或 userKey，用于判断是否他人修改。 */
export interface PageInfo {
  id: string;
  title: string;
  version: number;
  updated?: string;
  modifier?: string;
  modifierKey?: string;
  /** 当前账号能否删除；服务器未返回 operations 时为 undefined（未知）。 */
  canDelete?: boolean;
}
/** 页面层级元数据；ancestorIds 自根到直接父页，末项为父页。 */
export interface PageNode extends PageInfo {
  spaceKey: string;
  ancestorIds: string[];
  url: string;
}
export interface Attachment {
  id: string;
  title: string;
  version: number | null;
  mediaType?: string;
  size?: number;
  url: string;
}
export interface Region {
  id: string;
  label: string;
  start: number;
  end: number;
  wiki: string;
  lossy: boolean;
}
export interface Section {
  id: string;
  regionId: string;
  title: string;
  level: number;
  path: string;
  start: number;
  bodyStart: number;
  end: number;
  wiki: string;
  lossy: boolean;
}
export interface ReadPage extends Omit<Page, "storage"> {
  wiki: string;
  html: string;
  sections: Section[];
  regions: Region[];
  warnings: string[];
  lossy: boolean;
  snapshotId: string;
  storage?: string;
}
export interface Draft {
  id: string;
  profile: string;
  host: string;
  kind: "create" | "update";
  createdAt: string;
  pageId?: string;
  parentId?: string;
  spaceKey: string;
  title: string;
  expectedVersion?: number;
  snapshotId?: string;
  storage: string;
  wiki: string;
  change: { mode: string; before: string; after: string };
  warnings: string[];
}
export interface ComposerDraft {
  text: string;
  images: { data: string; name: string; mimeType: string }[];
  warnings: string[];
}
