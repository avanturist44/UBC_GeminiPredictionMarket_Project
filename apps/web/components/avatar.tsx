import { cn } from '@/lib/utils';

/** Initials on a plain disc for people, on a rounded square for agents. */
export function Avatar({
  name,
  kind,
  className,
}: {
  name: string;
  kind: 'agent' | 'human';
  /** Overrides the 40px size, for denser lists. */
  className?: string;
}) {
  const initials =
    name
      .split(/[\s_-]+/)
      // Words only: "Guest 1538" is G, not G1.
      .filter((part) => /^[a-z]/i.test(part))
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-10 shrink-0 items-center justify-center bg-secondary text-sm font-medium',
        kind === 'agent' ? 'rounded-lg text-primary' : 'rounded-full text-muted-foreground',
        className,
      )}
    >
      {initials}
    </span>
  );
}
