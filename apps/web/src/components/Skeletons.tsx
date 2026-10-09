/** Loading skeletons: card + list variants. */

export function CardSkeleton() {
  return (
    <div
      className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
      aria-hidden="true"
    >
      <div className="h-4 w-2/3 rounded bg-zinc-800" />
      <div className="mt-3 h-3 w-full rounded bg-zinc-800/70" />
      <div className="mt-2 h-3 w-5/6 rounded bg-zinc-800/70" />
      <div className="mt-4 flex gap-2">
        <div className="h-5 w-16 rounded-full bg-zinc-800" />
        <div className="h-5 w-20 rounded-full bg-zinc-800" />
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
        >
          <div className="h-3.5 w-1/2 rounded bg-zinc-800" />
          <div className="mt-2 h-3 w-3/4 rounded bg-zinc-800/70" />
        </div>
      ))}
    </div>
  );
}
