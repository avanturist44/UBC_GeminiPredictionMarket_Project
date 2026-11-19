'use client';

import { Heart } from 'lucide-react';
import { useEffect, useState } from 'react';
import { mutate } from 'swr';
import type { LikeResponse } from '@/lib/thesis-view';
import { cn } from '@/lib/utils';

/**
 * Like or unlike. The count changes at once and is corrected by the server's answer. A first
 * like starts a guest session, as a first copy does.
 */
export function LikeButton({
  thesisId,
  liked: initialLiked,
  likes: initialLikes,
  disabled,
}: {
  thesisId: string;
  liked: boolean;
  likes: number;
  /** The viewer wrote the thesis. */
  disabled: boolean;
}) {
  const [state, setState] = useState({ liked: initialLiked, likes: initialLikes });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A fresher read of the feed wins, unless a request of ours is still in flight.
  useEffect(() => {
    if (!busy) setState({ liked: initialLiked, likes: initialLikes });
  }, [initialLiked, initialLikes, busy]);

  async function toggle() {
    const next = !state.liked;
    const before = state;
    setBusy(true);
    setProblem(null);
    setState({ liked: next, likes: Math.max(0, state.likes + (next ? 1 : -1)) });
    try {
      const send = () =>
        fetch(`/api/theses/${thesisId}/like`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ liked: next }),
        });
      let response = await send();
      if (response.status === 401) {
        const session = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!session.ok) throw new Error('session');
        void mutate('/api/me');
        response = await send();
      }
      const body = (await response.json().catch(() => null)) as (LikeResponse & { message?: string }) | null;
      if (!response.ok || !body) {
        setState(before);
        setProblem(body?.message ?? 'The like was not saved.');
        return;
      }
      setState({ liked: body.liked, likes: body.likes });
    } catch {
      setState(before);
      setProblem('The like was not saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || busy}
      aria-pressed={state.liked}
      aria-label={`${state.liked ? 'Unlike' : 'Like'}, ${state.likes} ${state.likes === 1 ? 'like' : 'likes'}`}
      title={disabled ? 'You cannot like your own thesis' : (problem ?? undefined)}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm tabular-nums transition-colors disabled:cursor-default',
        state.liked ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        problem && 'text-no',
      )}
    >
      <Heart aria-hidden className="size-[18px]" strokeWidth={1.75} fill={state.liked ? 'currentColor' : 'none'} />
      {state.likes}
    </button>
  );
}
