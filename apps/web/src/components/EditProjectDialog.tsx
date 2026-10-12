import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { Project } from '../types';

export interface EditProjectValues {
  name: string;
  description: string;
}

export function EditProjectDialog({
  project,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  project: Project | null;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (values: EditProjectValues) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');

  if (!project) return null;
  const valid = name.trim().length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-project-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="edit-project-title" className="text-base font-semibold text-zinc-100">
            {t('editProject.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit({ name: name.trim(), description: description.trim() });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-zinc-300">{t('editProject.name')}</span>
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-zinc-300">{t('editProject.description')}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={5}
              className="resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
            />
          </label>

          {error && (
            <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t('editProject.saving') : t('editProject.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
