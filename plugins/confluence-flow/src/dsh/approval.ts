import { designation } from "../runtime/delete-authority.js";
import type {
  DeleteAuthorization,
  DeleteTarget,
} from "../runtime/deletes.js";

export const DELETE_TOOL = "confluence_flow_delete";

const GUIDE =
  "请用户在消息中写明删除及页面链接/ID/完整标题（多页时注明“连同子页”）";

/** 只取用户亲自输入的文字；工具结果、插件注入内容的来源不是 user。 */
function userTexts(session: any): string[] {
  const messages =
    typeof session?.deriveMessages === "function"
      ? session.deriveMessages()
      : [];
  return messages
    .filter(
      (row: any) => row?.role === "user" && row?.source?.kind === "user",
    )
    .map((row: any) =>
      (Array.isArray(row.content) ? row.content : [])
        .filter(
          (block: any) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block: any) => block.text)
        .join("\n"),
    )
    .filter(Boolean);
}

export function deleteReason(target: DeleteTarget): string {
  const scope = target.keepRoot
    ? `删除 Confluence 页面《${target.title}》下的全部子页面共 ${target.count} 页（保留该页面本身）`
    : `删除 Confluence 页面《${target.title}》${target.count > 1 ? `及其全部子页面，共 ${target.count} 页` : ""}`;
  return `${scope}，移到回收站（空间 ${target.spaceKey}，页面 ${target.id}）`;
}

/**
 * DSH 删除授权：顶层会话中用户本人明确指定即放行；否则通过 ctx.approval 在本次工具调用上弹窗，
 * 只有“允许一次”才继续。子代理会话的 user 消息由父 agent 撰写，不能作为用户指定。
 * 全访问（审批策略 never）会话不会弹窗，请求被自动拒绝，此时提示用户改用明确指定。
 */
export async function authorizeInDsh(
  ctx: any,
  exec: any,
  target: DeleteTarget,
): Promise<DeleteAuthorization> {
  const agent = exec?.agent;
  const session = agent?.session;
  const header = session?.header;
  let note = "当前不是用户直接对话的会话，不能按消息内容授权";
  if (header && header.origin !== "subagent" && !header.delegationDepth) {
    const verdict = designation(userTexts(session), target);
    if (verdict.ok) {
      return { method: "explicit", detail: verdict.reason };
    }
    note = verdict.reason;
  }
  const approval =
    typeof ctx?.get === "function" ? ctx.get("approval") : undefined;
  if (!approval || !agent) {
    throw new Error(
      `${note}；当前环境没有确认弹窗，未删除任何页面。${GUIDE}`,
    );
  }
  const outcome = await approval.request({
    agent,
    toolName: DELETE_TOOL,
    callId: exec.callId,
    reason: deleteReason(target),
    signal: exec.signal,
  });
  if (outcome === "allowed-once") {
    return { method: "approved" };
  }
  if (outcome === "rejected") {
    const policy =
      (typeof approval.overrideOf === "function"
        ? approval.overrideOf(session)
        : undefined) ?? approval.config?.policy;
    if (policy === "never") {
      throw new Error(
        `当前会话为全访问模式，不能弹窗确认；${note}。未删除任何页面。${GUIDE}，或切换到 workspace-write 后重试`,
      );
    }
    throw new Error(
      "用户在确认弹窗中拒绝了删除，未删除任何页面。除非用户再次明确要求，不要重试",
    );
  }
  if (outcome === "cancelled") {
    throw new Error("删除确认已取消，未删除任何页面");
  }
  throw new Error(`没有可用的确认通道，未删除任何页面。${GUIDE}`);
}
