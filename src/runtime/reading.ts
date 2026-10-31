import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page, Profile } from "../types.js";
import type { ToolInput } from "./schema.js";
import type { ConfluenceClient } from "../core/confluence.js";
import { analyzeStorage } from "../core/storage.js";
import {
  dataFile,
  dataHome,
  hash,
  jsonRead,
  jsonWrite,
  message,
  validId,
} from "./store.js";
import { characterBoundary, fitRows, fitText, jsonOutput } from "./output.js";

const CACHE_MS = 5 * 60_000;
interface SavedPage extends Page {
  profile?: string;
  host?: string;
  fetchedAt?: string;
}
interface LoadedPage {
  page: SavedPage;
  snapshotId: string;
  source: "live" | "cache" | "snapshot";
  fetchedAt: string;
}
interface CachedPage {
  profile: string;
  host: string;
  id: string;
  snapshotId: string;
  fetchedAt: string;
}
interface SavedBatch {
  profile: string;
  host: string;
  results: any[];
  stats: {
    requested: number;
    unique: number;
    fetched: number;
    cached: number;
    failed: number;
  };
  operation: string;
}

function metadata(loaded: LoadedPage) {
  const { page, snapshotId, source, fetchedAt } = loaded;
  return {
    id: page.id,
    title: page.title,
    spaceKey: page.spaceKey,
    version: page.version,
    url: page.url,
    updated: page.updated,
    snapshotId,
    source,
    fetchedAt,
  };
}
function summarizeWarnings(warnings: string[]): string[] {
  return (
    warnings.length > 4
      ? [
          ...warnings.slice(0, 3),
          `另有 ${warnings.length - 3} 项特殊格式提示，可用 format=full 查看。`,
        ]
      : warnings
  ).map((warning) => warning.slice(0, 200));
}
/**
 * 续读位置越界时报错。夹取到末尾会返回空结果且无续读位置，调用方无法区分“没有内容”和“位置错误”。
 * 0 始终有效，以便读取空正文、空目录或空批次。
 */
function assertResumePosition(
  value: number,
  total: number,
  name: string,
  totalName: string,
  next: string,
) {
  if (value > 0 && value >= total) {
    throw new Error(
      `${name}=${value} 超出范围（${totalName}=${total}），请使用返回的 ${next} 续读`,
    );
  }
}
export async function invalidateReadCache(profile: Profile, id: string) {
  await jsonWrite(
    dataFile("read-cache", hash(`${profile.id}|${profile.host}|${id}`)),
    {
      profile: profile.id,
      host: profile.host,
      id,
      fetchedAt: "1970-01-01T00:00:00.000Z",
      snapshotId: "invalidated",
    },
  );
}
export function literalMatches(
  text: string,
  needle: string,
  caseSensitive: boolean,
  context: number,
) {
  // A literal RegExp preserves UTF-16 offsets even for case folding of non-ASCII text.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexp = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  const matches: { offset: number; end: number; text: string }[] = [];
  for (const match of text.matchAll(regexp)) {
    const at = match.index!;
    matches.push({
      offset: at,
      end: at + match[0].length,
      text: text.slice(
        characterBoundary(text, at - context),
        characterBoundary(text, at + match[0].length + context),
      ),
    });
  }
  return matches;
}

export class PageReader {
  private clientPromise?: Promise<ConfluenceClient>;
  private pending = new Map<string, Promise<LoadedPage>>();
  constructor(
    private readonly profile: Profile,
    private readonly makeClient: () => Promise<ConfluenceClient>,
    private readonly signal?: AbortSignal,
  ) {}
  private client() {
    return (this.clientPromise ||= this.makeClient());
  }
  private assertSource(page: SavedPage, snapshotId: string) {
    if (
      (page.profile && page.profile !== this.profile.id) ||
      (page.host && page.host !== this.profile.host) ||
      !page.url?.startsWith(this.profile.host + "/") ||
      !snapshotId.startsWith(
        `${this.profile.id}-${page.id}-${page.version}-`,
      ) ||
      !snapshotId.endsWith(hash(page.storage).slice(0, 12))
    ) {
      throw new Error("快照不属于当前连接或内容校验失败");
    }
  }
  async snapshot(snapshotId: string): Promise<LoadedPage> {
    const file = dataFile("snapshots", snapshotId);
    const page = await jsonRead<SavedPage>(file);
    this.assertSource(page, snapshotId);
    const fetchedAt = page.fetchedAt || (await stat(file)).mtime.toISOString();
    return { page, snapshotId, source: "snapshot", fetchedAt };
  }
  private localId(reference: string): string | undefined {
    if (/^\d+$/.test(reference)) {
      return reference;
    }
    if (this.profile.targets[reference]) {
      return this.profile.targets[reference];
    }
    try {
      const url = new URL(reference);
      const base = new URL(this.profile.host);
      if (
        url.origin !== base.origin ||
        !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/")
      ) {
        throw new Error("页面链接不属于当前 Confluence 连接");
      }
      const id =
        url.searchParams.get("pageId") ||
        url.pathname.match(/\/pages\/(\d+)(?:\/|$)/)?.[1];
      if (id && /^\d+$/.test(id)) {
        return id;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("不属于")) {
        throw error;
      }
    }
    return undefined;
  }
  async load(reference: string, refresh: boolean): Promise<LoadedPage> {
    this.signal?.throwIfAborted();
    const id =
      this.localId(reference) ||
      (await (await this.client()).resolve(reference));
    if (this.pending.has(id)) {
      return this.pending.get(id)!;
    }
    const task = this.loadId(id, refresh);
    this.pending.set(id, task);
    return task;
  }
  private async loadId(id: string, refresh: boolean): Promise<LoadedPage> {
    const file = dataFile(
      "read-cache",
      hash(`${this.profile.id}|${this.profile.host}|${id}`),
    );
    if (!refresh) {
      const index = await jsonRead<CachedPage | null>(file, null);
      if (
        index &&
        index.profile === this.profile.id &&
        index.host === this.profile.host &&
        index.id === id &&
        Date.now() - Date.parse(index.fetchedAt) < CACHE_MS
      ) {
        try {
          const saved = await this.snapshot(index.snapshotId);
          return { ...saved, source: "cache", fetchedAt: index.fetchedAt };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      // Reuse recent snapshots written by 0.1.0 before the cache index existed.
      if (!index) {
        const directory = path.join(dataHome(), "snapshots");
        const names = (
          await readdir(directory).catch(() => [] as string[])
        ).filter(
          (name) =>
            name.startsWith(`${this.profile.id}-${id}-`) &&
            name.endsWith(".json"),
        );
        const candidates = await Promise.all(
          names.map(async (name) => ({
            id: name.slice(0, -5),
            mtime: (await stat(path.join(directory, name))).mtimeMs,
          })),
        );
        candidates.sort((a, b) => b.mtime - a.mtime);
        for (const candidate of candidates) {
          if (Date.now() - candidate.mtime >= CACHE_MS) {
            break;
          }
          const saved = await this.snapshot(candidate.id).catch((error) => {
            if (error instanceof Error && error.message.includes("不属于")) {
              return null;
            }
            throw error;
          });
          if (!saved) {
            continue;
          }
          if (Date.now() - Date.parse(saved.fetchedAt) >= CACHE_MS) {
            continue;
          }
          await jsonWrite(file, {
            profile: this.profile.id,
            host: this.profile.host,
            id,
            snapshotId: saved.snapshotId,
            fetchedAt: saved.fetchedAt,
          });
          return { ...saved, source: "cache" };
        }
      }
    }
    const raw = await (await this.client()).get(id);
    const fetchedAt = new Date().toISOString();
    const page: SavedPage = {
      ...raw,
      profile: this.profile.id,
      host: this.profile.host,
      fetchedAt,
    };
    const snapshotId = `${this.profile.id}-${page.id}-${page.version}-${hash(this.profile.host).slice(0, 8)}-${hash(page.storage).slice(0, 12)}`;
    await jsonWrite(dataFile("snapshots", snapshotId), page);
    await jsonWrite(file, {
      profile: this.profile.id,
      host: this.profile.host,
      id,
      snapshotId,
      fetchedAt,
    });
    return { page, snapshotId, source: "live", fetchedAt };
  }
  project(loaded: LoadedPage, input: ToolInput, scanning = false): any {
    const full = input.format === "full" || input.raw === true;
    const detailed = full || input.format === "outline" || !!input.sectionId;
    const parsed = analyzeStorage(loaded.page.storage, this.profile.host, {
      html: full,
      details: detailed,
    });
    const base = {
      ...metadata(loaded),
      lossy: parsed.lossy,
      warnings: summarizeWarnings(parsed.warnings),
    };
    if (full && !scanning) {
      const { storage, profile, host, fetchedAt, ...page } = loaded.page;
      return jsonOutput({
        ...page,
        ...parsed,
        ...metadata(loaded),
        ...(input.raw ? { storage } : {}),
        outputMode: "full-explicit",
      });
    }
    if (input.format === "outline" && !scanning) {
      // 位置是原始 storage 下标，供编辑定位；显式命名，避免被当作 wiki offset 续读而越界。
      const sections = parsed.sections.map(
        ({ wiki, start, bodyStart, end, ...section }) => ({
          ...section,
          storageStart: start,
          storageBodyStart: bodyStart,
          storageEnd: end,
          wikiChars: wiki.length,
        }),
      );
      const regions = parsed.regions.map(({ wiki, start, end, ...region }) => ({
        ...region,
        storageStart: start,
        storageEnd: end,
        wikiChars: wiki.length,
      }));
      const rows = [
        ...regions.map((region) => ({ kind: "region", ...region })),
        ...sections.map((section) => ({ kind: "section", ...section })),
      ];
      assertResumePosition(
        input.start,
        rows.length,
        "start",
        "totalItems",
        "nextStart",
      );
      return fitRows(
        rows.slice(input.start),
        (selected) => ({
          ...base,
          format: "outline",
          positionSpace: "storage",
          items: selected,
          totalItems: rows.length,
          start: input.start,
          nextStart:
            input.start + selected.length < rows.length
              ? input.start + selected.length
              : null,
        }),
        input.maxBytes,
      );
    }
    const section = input.sectionId
      ? parsed.sections.find((section) => section.id === input.sectionId)
      : undefined;
    if (input.sectionId && !section) {
      throw new Error("此快照没有指定的 sectionId");
    }
    const wiki = section ? section.wiki : parsed.wiki;
    const totalChars = wiki.length;
    const info = scanning
      ? {
          id: loaded.page.id,
          title: loaded.page.title,
          version: loaded.page.version,
          snapshotId: loaded.snapshotId,
          totalChars,
          lossy: parsed.lossy,
          warningCount: parsed.warnings.length,
        }
      : { ...base, ...(section ? { sectionId: section.id } : {}), totalChars };
    if (input.grep) {
      const matches = literalMatches(
        wiki,
        input.grep,
        input.caseSensitive,
        input.context,
      );
      const from = input.matchOffset;
      if (!scanning) {
        // 批量扫描各页命中数不同，沿用空结果；单页读取需要指出错误的命中位置。
        assertResumePosition(
          from,
          matches.length,
          "matchOffset",
          "matchCount",
          "nextMatchOffset",
        );
      }
      const count = scanning ? 1 : input.maxMatches;
      return fitRows(
        matches.slice(from, from + count),
        (selected) => ({
          ...info,
          grep: input.grep,
          matchCount: matches.length,
          matchOffset: from,
          matches: selected,
          nextMatchOffset:
            from + selected.length < matches.length
              ? from + selected.length
              : null,
        }),
        input.maxBytes,
      );
    }
    if (scanning) {
      return { ...info, snippet: wiki.slice(0, 160) };
    }
    assertResumePosition(
      input.offset,
      totalChars,
      "offset",
      "totalChars",
      "nextOffset",
    );
    const offset = characterBoundary(wiki, input.offset);
    let text = wiki.slice(offset);
    if (input.head !== undefined) {
      let end = 0;
      for (let line = 0; line < input.head; line++) {
        const next = text.indexOf("\n", end);
        if (next < 0) {
          end = text.length;
          break;
        }
        end = next + 1;
      }
      text = text.slice(0, end);
    }
    return fitText(
      text,
      (part) => ({
        ...info,
        format: "wiki",
        offset,
        wiki: part,
        truncated: offset + part.length < totalChars,
        nextOffset:
          offset + part.length < totalChars ? offset + part.length : null,
      }),
      input.maxBytes,
    );
  }
  async read(input: ToolInput) {
    const loaded = input.snapshotId
      ? await this.snapshot(input.snapshotId)
      : await this.load(input.page || "", input.refresh);
    return this.project(loaded, input);
  }
  async batch(input: ToolInput) {
    if (input.scanId) {
      return this.resume(input);
    }
    const references = [
      ...new Set(input.pages || (input.page ? [input.page] : [])),
    ];
    if (!references.length) {
      throw new Error("批量读取需要 pages，或提供 scanId 继续读取");
    }
    if (input.format === "full" || input.raw) {
      throw new Error("批量读取使用 wiki 或 outline；full 仅支持显式单页读取");
    }
    const results: any[] = new Array(references.length);
    const stats = {
      requested: (input.pages || references).length,
      unique: references.length,
      fetched: 0,
      cached: 0,
      failed: 0,
    };
    const seen = new Set<string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < references.length) {
        this.signal?.throwIfAborted();
        const at = cursor++;
        const reference = references[at];
        try {
          const loaded = await this.load(reference, input.refresh);
          if (!seen.has(loaded.page.id)) {
            seen.add(loaded.page.id);
            stats[loaded.source === "live" ? "fetched" : "cached"]++;
          }
          const row = this.project(
            loaded,
            { ...input, maxBytes: Math.min(input.maxBytes - 1100, 6500) },
            input.operation === "scan",
          );
          results[at] = { ...row, status: "ok" };
        } catch (error) {
          if (this.signal?.aborted) {
            throw error;
          }
          stats.failed++;
          results[at] = {
            page: reference.slice(0, 300),
            status: "error",
            error: message(error).slice(0, 300),
            automaticRetry: false,
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, references.length) }, worker),
    );
    const uniqueResults = results.filter(
      (row, at) =>
        !row.id || results.findIndex((other) => other.id === row.id) === at,
    );
    stats.unique = uniqueResults.length;
    const scanId = randomUUID();
    await jsonWrite(dataFile("scans", scanId), {
      profile: this.profile.id,
      host: this.profile.host,
      results: uniqueResults,
      stats,
      operation: input.operation,
    } satisfies SavedBatch);
    return this.resume({ ...input, scanId, start: 0 });
  }
  async resume(input: ToolInput) {
    const scanId = validId(input.scanId!);
    const batch = await jsonRead<SavedBatch>(dataFile("scans", scanId));
    if (batch.profile !== this.profile.id || batch.host !== this.profile.host) {
      throw new Error("批次不属于当前连接");
    }
    assertResumePosition(
      input.start,
      batch.results.length,
      "start",
      "totalResults",
      "nextStart",
    );
    return fitRows(
      batch.results.slice(input.start),
      (results) => ({
        scanId,
        operation: batch.operation,
        stats: batch.stats,
        results,
        start: input.start,
        totalResults: batch.results.length,
        nextStart:
          input.start + results.length < batch.results.length
            ? input.start + results.length
            : null,
        source: "local-scan",
      }),
      input.maxBytes,
    );
  }
}
