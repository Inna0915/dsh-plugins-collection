/**
 * 判断用户本人的消息是否明确指定了这次删除。只作为免弹窗的放行条件：任何不确定都判为未指定，
 * 由调用方退回弹窗确认（或在无法弹窗时拒绝）。调用方负责只传入用户亲自输入的消息。
 */
export interface DesignationTarget {
  id: string;
  title: string;
  /** 将删除的页面数。 */
  count: number;
  /** true 表示只删除子页面、保留该页面本身。 */
  keepRoot?: boolean;
}
export interface Designation {
  ok: boolean;
  reason: string;
}

/** 只看最近几条用户消息；更早的指令可能已被后续对话改变。 */
const RECENT_MESSAGES = 6;
// 分句时保留句末标点，用于识别询问；逗号不分句，避免把“删除 A，不要删 B”拆开放行。
const SEGMENT = /[^。！？!?；;\n]+[。！？!?；;]*/g;
const VERB =
  /删|(?:移|放|丢|扔)(?:到|入|进)?回收站|\b(?:delete|trash)\b/i;
const NEGATION =
  /(?:不|别|勿|没|无需|不必|先别|暂时别|停止|取消)[^，,。！？!?；;\n]{0,4}?(?:删|(?:移|放|丢|扔)(?:到|入|进)?回收站)|\b(?:don'?t|do\s+not|not|never|stop|cancel)\s+(?:\w+\s+){0,2}?(?:delete|trash)/i;
const QUESTION =
  /[?？]|吗|是否|要不要|能否|能不能|可不可以|可否|行不行|怎么|如何|\b(?:why|how|whether)\b/i;
// 页面内的局部删除（段落、表格、附件等）不是删除页面。
const PARTIAL =
  /(?:里|中|内)的|段落|章节|小节|表格|单元格|图片|截图|附件|字段|这一?段|这一?行|\b(?:section|paragraph|table|row|image|attachment)s?\b/i;
// 连同页面本身删除：“X 及子页”“连同子页面”“整个目录”。
const WITH_ROOT =
  /及其?(?:所有|全部)?(?:子|下)|以及(?:所有|全部)?子|和(?:所有|全部)?子|连同|整个|整棵|子树|包括(?:它|该页|此页|这个页面|本身|自身)|\b(?:and|with)\s+(?:all\s+)?(?:its\s+)?(?:children|sub-?pages|descendants)\b|\b(?:subtree|recursive(?:ly)?)\b/i;
// 页面下的内容：“X 下的所有文档”“子页面”。
const CHILDREN =
  /子页|子文档|子目录|子节点|下级|下属|下的?(?:所有|全部)|下面的?(?:所有|全部)|以下(?:所有|全部)|(?:所有|全部)(?:子)?(?:页面|文档)|\b(?:children|sub-?pages|descendants)\b/i;
// 明确保留页面本身：“不包括这个页面”“保留本页”。
const KEEP_ROOT =
  /(?:不(?:包括|包含|含)|保留|(?<![删移消清去])除了?)(?:(?:这个|该|此|本|根|父)(?:页面|页)?|(?:页面|页)?(?:本身|自身)|它(?:本身)?)|(?:本身|自身)(?:不删|保留)|\bonly\s+(?:the\s+)?(?:children|sub-?pages)\b|\bkeep(?:ing)?\s+(?:the\s+)?(?:root|page|parent)\b|\bexcluding\s+(?:the\s+)?(?:root|page|parent)\b/i;
// 明确不删子页面：“不含子页”“保留子页面”。
const NO_CHILDREN =
  /(?:不(?:包括|包含|含|动)|保留)(?:其|它的|所有|全部)?(?:子|下)|(?:子页|子页面|子文档)(?:不动|保留)|\b(?:without|excluding|not)\s+(?:the\s+)?(?:children|sub-?pages)\b/i;
// 标题须作为完整词出现：两侧是边界、空白、标点，或常见的动词/连接词，避免“测试环境”误配“测试环境文档”。
const LEFT = "删除|删掉|删去|删|移除|把|将|对";
const RIGHT =
  "及其|及|和|与|以及|连同|包括|下面|下的|下所有|下全部|的|这个|整个|页面|页|目录|子";

const URL_PATTERN = /https?:\/\/[^\s<>"'）)]+/g;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentions(text: string, target: DesignationTarget): boolean {
  if (new RegExp(`(?<!\\d)${escape(target.id)}(?!\\d)`).test(text)) {
    return true;
  }
  const title = target.title.trim();
  if (title.length < 2) {
    return false;
  }
  const decoded = (text.match(URL_PATTERN) || []).map((url) => {
    try {
      return decodeURIComponent(url.replace(/\+/g, " "));
    } catch {
      return "";
    }
  });
  const pattern = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}]|${LEFT})${escape(title)}(?=$|[\\s\\p{P}\\p{S}]|${RIGHT})`,
    "u",
  );
  return [text, ...decoded].some((value) => pattern.test(value));
}

/** 消息的删除范围须与本次删除一致；保留与否表述不清时判为未指定。 */
function scopeMismatch(
  text: string,
  target: DesignationTarget,
): string | undefined {
  if (NO_CHILDREN.test(text) && (target.keepRoot || target.count > 1)) {
    return "消息要求保留子页面，但本次会删除子页面";
  }
  if (target.keepRoot) {
    return CHILDREN.test(text) || KEEP_ROOT.test(text)
      ? undefined
      : "消息没有说明删除该页面下的子页面";
  }
  if (KEEP_ROOT.test(text) || (CHILDREN.test(text) && !WITH_ROOT.test(text))) {
    return "消息指的是该页面下的文档，但本次会连同页面本身删除";
  }
  return target.count > 1 && !WITH_ROOT.test(text)
    ? `将删除 ${target.count} 页，但消息没有说明连同子页面一起删除`
    : undefined;
}

/**
 * 从最新消息往前看：出现“不要删/先别删”立即判为未指定；第一条提到目标（ID、链接或完整标题）的消息
 * 决定结果——须是删除指令而非询问或局部删除，且删除范围（连同页面本身或只删子页面）与本次一致。
 * @param messages 用户亲自输入的消息文本，按时间先后排列。
 */
export function designation(
  messages: string[],
  target: DesignationTarget,
): Designation {
  for (const text of messages.slice(-RECENT_MESSAGES).reverse()) {
    // 链接只用于匹配目标；分析措辞时去掉，避免查询串里的“?”或单词被当成询问或指令。
    const prose = text.replace(URL_PATTERN, " ");
    const verbs = (prose.match(SEGMENT) || []).filter((part) => VERB.test(part));
    if (verbs.some((part) => NEGATION.test(part))) {
      return { ok: false, reason: "你最近的消息里有不要删除或暂不删除的表述" };
    }
    if (!mentions(text, target)) {
      continue;
    }
    if (!verbs.length) {
      return { ok: false, reason: "最近提到该页面的消息没有删除指令" };
    }
    if (verbs.some((part) => QUESTION.test(part))) {
      return { ok: false, reason: "提到该页面的消息是询问，不是删除指令" };
    }
    if (verbs.some((part) => PARTIAL.test(part))) {
      return { ok: false, reason: "消息像是删除页面里的部分内容，不是删除页面" };
    }
    const mismatch = scopeMismatch(prose, target);
    if (mismatch) {
      return { ok: false, reason: mismatch };
    }
    return {
      ok: true,
      reason: target.keepRoot
        ? "用户消息明确指定了删除该页面下的子页面"
        : "用户消息明确指定了删除该页面",
    };
  }
  return {
    ok: false,
    reason: "最近的消息没有明确指定删除该页面（页面 ID、链接或完整标题）",
  };
}
