import { z } from 'zod';
import { findInsideInfoPhrases } from './auditor';

/**
 * Rules for comments. Not in the build plan: comments are a social layer on top of theses,
 * so they follow the plan's content rule for theses where it applies. A comment that claims
 * inside information is refused before it is stored. Comments cost nothing to check: the
 * phrase screen runs in code and no language model is called.
 */

export const COMMENT_MAX = 500;
/** Comments one user may post in a UTC day. */
export const COMMENTS_PER_DAY = 50;

export const CommentSchema = z.object({
  body: z.string().trim().min(1, 'Write something first.').max(COMMENT_MAX, `A comment is at most ${COMMENT_MAX} characters.`),
});

export type CommentCheck = { ok: true; body: string } | { ok: false; code: string; message: string };

/** Parses and screens a comment. Collapses runs of blank lines so a comment cannot fill the page. */
export function checkComment(input: unknown): CommentCheck {
  const parsed = CommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'The comment is not valid.' };
  }
  const body = parsed.data.body.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (findInsideInfoPhrases(body).length > 0) {
    return {
      ok: false,
      code: 'inside_info',
      message: 'Argue from public evidence. Comments claiming inside information are not posted.',
    };
  }
  return { ok: true, body };
}
