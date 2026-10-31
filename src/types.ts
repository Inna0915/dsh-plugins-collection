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
