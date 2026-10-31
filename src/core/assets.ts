import type { Issue } from '../types.js';

// Jira rendered HTML can retain an old hostname or thumbnail URL. Resolve a
// known attachment to the canonical URL returned with this issue, never forward
// credentials to the URL embedded in the document.
export function resolveAttachment(issue: Issue, source: string) {
  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    /* Preserve malformed source for exact matching. */
  }
  return issue.attachments.find(
    (attachment) =>
      [attachment.content, attachment.thumbnail, attachment.filename].includes(source) ||
      attachment.filename === decoded ||
      decoded.includes(`/attachment/${attachment.id}/`) ||
      decoded.includes(`/thumbnail/${attachment.id}/`),
  );
}
