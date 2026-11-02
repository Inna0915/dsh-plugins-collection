import { z } from "zod";

export const operationNames = [
  "profiles",
  "doctor",
  "search",
  "read",
  "scan",
  "children",
  "attachments",
  "preview",
  "create",
  "update",
  "commit",
  "upload",
  "move",
  "operation-status",
] as const;
export const toolShape = {
  operation: z.enum(operationNames),
  profile: z.string().default("work-confluence").describe("已配置的连接别名"),
  page: z.string().optional().describe("页面 ID、完整 URL 或发布位置别名"),
  pages: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(50)
    .optional()
    .describe("批量页面，最多 50 个，去重并以最多 4 并发抓取"),
  format: z
    .enum(["wiki", "outline", "full"])
    .default("wiki")
    .describe(
      "默认仅 wiki；outline 获取章节标识；full 显式返回完整 UI 表示，不受默认输出预算限制",
    ),
  grep: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("wiki 正文字面匹配，默认不区分大小写，不执行正则"),
  context: z.number().int().min(0).max(500).default(120),
  caseSensitive: z.boolean().default(false),
  maxMatches: z.number().int().min(1).max(50).default(6),
  matchOffset: z.number().int().min(0).default(0),
  maxBytes: z
    .number()
    .int()
    .min(4096)
    .max(65536)
    .default(8192)
    .describe("紧凑读取/扫描/搜索的完整 JSON 输出预算，默认 8 KiB"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "wiki UTF-16 字符偏移，按 nextOffset 续读；不是 outline 的 storageStart，越界报错",
    ),
  head: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe("最多读取前 N 行"),
  snapshotId: z
    .string()
    .max(160)
    .optional()
    .describe("读取已缓存的固定版本快照，不请求服务器"),
  scanId: z
    .string()
    .max(80)
    .optional()
    .describe("继续读取本地批量结果，使用 start=nextStart"),
  refresh: z
    .boolean()
    .default(false)
    .describe("跳过五分钟阅读缓存，重新抓取；修改提交始终检查服务器最新版本"),
  parent: z
    .string()
    .optional()
    .describe("新页面或 move 目标的父页面 ID、URL 或发布位置别名"),
  query: z.string().optional(),
  space: z.string().optional(),
  label: z.string().max(200).optional(),
  match: z
    .enum(["all", "any", "phrase"])
    .default("all")
    .describe("搜索词全部匹配、任一匹配、索引短语；字面精确定位使用 grep"),
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("outline 目录、scanId 批次、搜索与子页面的行起点，按 nextStart 续读"),
  limit: z.number().int().min(1).max(100).default(30),
  title: z.string().max(255).optional(),
  wiki: z
    .string()
    .max(1_500_000)
    .optional()
    .describe("标准 Confluence wiki 标记，不是 Markdown"),
  layout: z.enum(["right-toc", "plain"]).optional(),
  mode: z.enum(["append", "replace-section", "replace-page"]).optional(),
  sectionId: z.string().optional(),
  regionId: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
  raw: z
    .boolean()
    .optional()
    .describe("显式单页完整表示，额外返回原始 storage；不受默认输出预算限制"),
  files: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .max(10)
    .optional()
    .describe(
      "upload 的本机文件绝对路径；同名附件上传为新版本。支持图片、SVG、drawio、PDF、Office 文档",
    ),
  comment: z.string().max(255).optional().describe("upload 的附件版本备注"),
  apply: z
    .boolean()
    .default(false)
    .describe("create/update/upload/move 默认生成预览；明确授权的写入设为 true"),
  draftId: z.string().optional(),
  requestId: z.string().optional(),
};
export const toolSchema = z.object(toolShape).strict();
export type ToolInput = z.infer<typeof toolSchema>;
export const toolDescription =
  "搜索 Confluence，返回摘要和 totalSize，默认多词 AND。read 默认仅 wiki、8 KiB JSON 预算，可 grep/head，snapshotId+offset 本地续读；scan+pages 批量缓存并仅返回命中次数和片段，scanId+start 继续结果，勿重复抓取。获取编辑章节标识用 format=outline；full 仅在需要完整 UI 数据时显式选择。写入需用户指令、apply=true 或 commit、稳定 requestId；更新须 expectedVersion，冲突重新读，不重发未知结果。upload+page+files 上传本机文件为页面附件（同名生成新版本），先预览，apply=true+稳定 requestId 提交，结果不明不重传。move+page+parent 把页面连同子页面移到同空间新父页下，正文不变，先预览，apply=true+稳定 requestId 提交。";
