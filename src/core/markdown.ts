import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { parseHTML } from 'linkedom';
import type { Issue } from '../types.js';
import { resolveAttachment } from './assets.js';

const markdown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
markdown.use(gfm);
markdown.remove(['script', 'style', 'iframe', 'object', 'form']);
export function safeUrl(value: string): string {
  if (/^(javascript|vbscript|data):/i.test(value.trim())) return '';
  return value;
}
export function wikiToMarkdown(value: string): string {
  return value
    .replace(
      /\{code(?::([^}]+))?\}([\s\S]*?)\{code\}/g,
      (_m, language, code) => `\n\n\`\`\`${language || ''}\n${code.trim()}\n\`\`\`\n\n`,
    )
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, (_m, code) => `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`)
    .replace(/^h([1-6])\.\s+(.*)$/gm, (_m, level, title) => '#'.repeat(Number(level)) + ' ' + title)
    .replace(
      /!([^!\n|]+)(?:\|[^!\n]*)?!/g,
      (_m, src) => `![${src.split('/').at(-1) || '图片'}](<${safeUrl(src)}>)`,
    )
    .replace(/\[([^\]\n|]+)\|([^\]\n]+)\]/g, (_m, label, url) => `[${label}](<${safeUrl(url)}>)`)
    .replace(/\[https?:\/\/[^\]\s]+\]/g, (match) => match.slice(1, -1))
    .replace(/\{\{([^}]+)\}\}/g, '`$1`')
    .replace(/^\*\s+/gm, '- ')
    .replace(/\*([^*\n]+)\*/g, '**$1**');
}
export function descriptionMarkdown(issue: Issue, replacements: Map<string, string> = new Map()): string {
  const replace = (src: string) => {
    const canonical = resolveAttachment(issue, src)?.content || src;
    return (
      replacements.get(src) ||
      replacements.get(decodeURIComponentSafe(src)) ||
      replacements.get(canonical) ||
      safeUrl(canonical)
    );
  };
  if (issue.descriptionFormat === 'html') {
    const { document } = parseHTML(`<html><body>${issue.description}</body></html>`);
    for (const image of document.querySelectorAll('img')) {
      const src =
        image.getAttribute('src') ||
        image.getAttribute('data-image-src') ||
        image.getAttribute('data-src') ||
        '';
      image.setAttribute('src', replace(src));
      if (!image.getAttribute('alt')) image.setAttribute('alt', '任务图片');
    }
    for (const link of document.querySelectorAll('a'))
      link.setAttribute('href', safeUrl(link.getAttribute('href') || ''));
    return markdown.turndown(document.body.innerHTML);
  }
  return wikiToMarkdown(issue.description).replace(
    /!\[([^\]]*)\]\(<?([^)>]+)>?\)/g,
    (_m, alt, src) => `![${alt}](<${replace(src)}>)`,
  );
}
export function inlineImages(issue: Issue): string[] {
  if (issue.descriptionFormat === 'html') {
    const { document } = parseHTML(`<html><body>${issue.description}</body></html>`);
    return [...document.querySelectorAll('img')]
      .map(
        (image) =>
          image.getAttribute('src') ||
          image.getAttribute('data-image-src') ||
          image.getAttribute('data-src') ||
          '',
      )
      .filter(Boolean);
  }
  return [...issue.description.matchAll(/!([^!\n|]+)(?:\|[^!\n]*)?!/g)].map((match) => match[1]);
}
export function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function issueMarkdown(
  issue: Issue,
  replacements = new Map<string, string>(),
  includeComments = true,
  options: { includeMetadata?: boolean; omitInlineAttachments?: boolean } = {},
): string {
  const lines =
    options.includeMetadata === false
      ? []
      : [
          `# ${issue.key} · ${issue.summary}`,
          '',
          `[在 Jira 中查看](<${issue.url}>)`,
          '',
          `- 类型：${issue.type}`,
          `- 状态：${issue.status.name}`,
          `- 优先级：${issue.priority || '未提供'}`,
          `- 经办人：${issue.assignee || '未分配'}`,
          `- 报告人：${issue.reporter || '未提供'}`,
          `- 迭代：${issue.sprint || '未提供'}`,
          `- 截止日期：${issue.dueDate || '未提供'}`,
          `- 故事点：${issue.storyPoints ?? '未提供'}`,
          `- Jira 更新时间：${issue.updated}`,
          '',
        ];
  lines.push('## 任务描述', '', descriptionMarkdown(issue, replacements) || '未提供', '');
  if (issue.links.length)
    lines.push(
      '## 关联任务',
      '',
      ...issue.links.map((link) => `- ${link.relation || '关联'}：${link.key} ${link.summary}`),
      '',
    );
  if (includeComments && issue.comments.length) {
    lines.push('## 评论', '');
    for (const comment of issue.comments)
      lines.push(
        `### ${comment.author} · ${comment.created}`,
        '',
        wikiToMarkdown(comment.body).replace(/!\[([^\]]*)\]\(<?([^)>]+)>?\)/g, (_m, alt, src) => {
          const canonical = resolveAttachment(issue, src)?.content || src;
          return `![${alt}](<${replacements.get(src) || replacements.get(canonical) || safeUrl(canonical)}>)`;
        }),
        '',
      );
  }
  const shownImages = new Set(inlineImages(issue).map((source) => resolveAttachment(issue, source)?.id));
  if (includeComments)
    for (const comment of issue.comments) {
      for (const match of comment.body.matchAll(/!([^!\n|]+)(?:\|[^!\n]*)?!/g))
        shownImages.add(resolveAttachment(issue, match[1])?.id);
    }
  const attachments = options.omitInlineAttachments
    ? issue.attachments.filter(
        (attachment) => !attachment.mimeType.startsWith('image/') || !shownImages.has(attachment.id),
      )
    : issue.attachments;
  if (attachments.length) {
    lines.push('## 附件', '');
    for (const attachment of attachments) {
      const target = replacements.get(attachment.content) || attachment.content;
      const name = attachment.filename.replace(/[\[\]\n]/g, '_');
      lines.push(
        attachment.mimeType.startsWith('image/') ? `![${name}](<${target}>)` : `- [${name}](<${target}>)`,
        '',
      );
    }
  }
  if (issue.warnings.length)
    lines.push('## 数据完整性', '', ...issue.warnings.map((warning) => `- ${warning}`), '');
  return lines.join('\n');
}
