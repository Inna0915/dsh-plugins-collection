import type { ComposerDraft } from "../types.js";

interface Insertion {
  start: number;
  end: number;
  draftRev: number;
}
interface InputActions {
  captureInsertion(): Insertion;
  insertText(text: string, span: Insertion): boolean;
  addAttachments(ids: string[]): boolean;
  persistDraft(): void;
}
interface Binding {
  key?: string;
  props: { inputActions?: InputActions };
  ctx?: {
    get(name: "conversation"): {
      createDrafts(sessionId: string, files: File[]): { id: string }[];
      releaseDraftAttachments(attachments: { id: string }[]): void;
    };
  };
}
export interface ComposerHost {
  uiSession: { adapter: { current: { getSnapshot(): Binding } } };
  layout: { selectPanel(id: string | null): void };
}
export type CaptureComposer = () => (draft: ComposerDraft) => string[];

/** Capture the destination, never its draft: keep edits made while Confluence is loading. */
export function captureCurrentComposer(
  host: ComposerHost,
  ownerSession?: string,
): ReturnType<CaptureComposer> {
  const captured = host.uiSession.adapter.current.getSnapshot();
  const actions = captured.props.inputActions;
  if (!captured.key || !actions)
    throw new Error("请先选择一个 DSH 会话，再添加任务");
  if (ownerSession && ownerSession !== captured.key)
    throw new Error("请切回此看板所属的会话后添加");
  let applied = false;
  return (draft) => {
    if (applied) throw new Error("此批任务已经添加，请在会话输入框查看");
    const current = host.uiSession.adapter.current.getSnapshot();
    if (current.key !== captured.key || current.props.inputActions !== actions)
      throw new Error("当前会话已切换，任务包已保留，请在目标会话中重新添加");
    const conversation = current.ctx?.get("conversation");
    if (draft.images.length && !conversation)
      throw new Error("当前宿主不支持图片附件，请使用图文任务包");
    const files = draft.images.map(
      (image) =>
        new File(
          [Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))],
          image.name,
          {
            type: image.mimeType,
          },
        ),
    );
    const attachments = conversation?.createDrafts(current.key!, files) || [];
    // The standard API uses detect coordinates (reference chips are not plain text).
    // Collapse to the selection end so even a selected existing draft is preserved.
    const span = actions.captureInsertion();
    let inserted = false;
    try {
      inserted = actions.insertText(`\n\n${draft.text}\n\n`, {
        ...span,
        start: span.end,
      });
    } finally {
      if (!inserted) conversation?.releaseDraftAttachments(attachments);
    }
    if (!inserted) {
      throw new Error("输入框暂不可编辑，任务包已保留；请稍后重新添加");
    }
    applied = true;
    const warnings = [...draft.warnings];
    if (
      !actions.addAttachments(attachments.map((attachment) => attachment.id))
    ) {
      conversation?.releaseDraftAttachments(attachments);
      warnings.push("正文已添加，图片未加入输入框，请从任务包补充图片");
    }
    try {
      actions.persistDraft();
      host.layout.selectPanel(null);
    } catch {
      warnings.push("内容已加入草稿，请切回会话检查；请勿重复添加");
    }
    return warnings;
  };
}
