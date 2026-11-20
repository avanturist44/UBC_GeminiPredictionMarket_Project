'use client';

import { COMMENT_MAX } from '@thesis/core/browser';
import { useState, type FormEvent } from 'react';
import { mutate } from 'swr';
import { LoadError } from '@/components/load-error';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { ago } from '@/lib/spark';
import type { CommentView, CommentsResponse } from '@/lib/thesis-view';
import { useLive, useNow } from '@/lib/use-live';

/**
 * The discussion under a thesis, oldest first. Anyone can read it; posting starts a guest
 * session if there is none. Comments that claim inside information are refused by the server.
 */
export function Comments({ thesisId }: { thesisId: string }) {
  const url = `/api/theses/${thesisId}/comments`;
  const { data, error, retry } = useLive<CommentsResponse>(url, undefined, 10_000);
  const { now } = useNow(undefined);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const send = () =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
      let response = await send();
      if (response.status === 401) {
        const session = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!session.ok) {
          setProblem('A session could not be started, so the comment was not posted.');
          return;
        }
        void mutate('/api/me');
        response = await send();
      }
      const result = (await response.json().catch(() => null)) as (CommentView & { message?: string }) | null;
      if (!response.ok || !result) {
        setProblem(result?.message ?? `The comment was not posted (status ${response.status}).`);
        return;
      }
      setBody('');
      void mutate<CommentsResponse>(url, (current) =>
        current ? { ...current, comments: [...current.comments, result] } : current,
      );
    } catch {
      setProblem('The comment was not posted: the server could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  const comments = data?.comments ?? [];
  return (
    <section id="comments" aria-labelledby="comments-heading" className="scroll-mt-6 space-y-4">
      <h2 id="comments-heading" className="text-lg font-medium">
        Discussion{data ? ` (${comments.length})` : ''}
      </h2>

      {error && !data && <LoadError message={error.message} onRetry={retry} />}

      {data && comments.length === 0 && (
        <p className="text-sm text-muted-foreground">No comments yet. Say where you think the author is right or wrong.</p>
      )}
      {comments.length > 0 && (
        <ul className="space-y-4">
          {comments.map((comment) => (
            <li key={comment.id} className="flex gap-3">
              <Avatar name={comment.displayName} kind="human" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm">
                  <span className="font-medium">{comment.displayName}</span>
                  {comment.byAuthor && (
                    <span className="rounded border border-primary/50 px-1 text-xs leading-5 text-primary">Author</span>
                  )}
                  {comment.byViewer && !comment.byAuthor && <span className="text-xs text-muted-foreground">You</span>}
                  <time dateTime={comment.createdAt} className="text-muted-foreground">
                    {ago(comment.createdAt, now)}
                  </time>
                </p>
                <p className="mt-0.5 text-[15px] leading-relaxed break-words whitespace-pre-line">{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="comment-body" className="sr-only">
          Your comment
        </label>
        <textarea
          id="comment-body"
          rows={3}
          maxLength={COMMENT_MAX}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add to the discussion"
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[15px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="h-9 px-4" disabled={busy || !body.trim()}>
            {busy ? 'Posting' : 'Post comment'}
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {body.length} of {COMMENT_MAX}
          </span>
          <span className="text-xs text-muted-foreground">Argue from public evidence.</span>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-no">
            {problem}
          </p>
        )}
      </form>
    </section>
  );
}
