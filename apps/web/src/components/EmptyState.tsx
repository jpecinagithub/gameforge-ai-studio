import type { ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-16 text-center">
      <div className="text-zinc-600" aria-hidden="true">
        {icon ?? <FolderOpen className="h-10 w-10" />}
      </div>
      <h2 className="text-base font-semibold text-zinc-200">{title}</h2>
      <p className="max-w-sm text-sm text-zinc-400">{body}</p>
      {action}
    </div>
  );
}
