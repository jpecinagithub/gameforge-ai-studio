import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

export const TEMPLATES = [
  'empty-three',
  'first-person',
  'third-person',
  'racing',
  'platformer-3d',
  'arcade-2d',
  'puzzle',
  'physics-sandbox',
] as const;

export const GAME_KINDS = [
  'first-person',
  'third-person',
  'top-down',
  'side-2d',
  'racing',
  'flight',
  'static-board',
  'free-camera',
] as const;

export interface NewProjectValues {
  name: string;
  description: string;
  template: string;
  kind: string;
}

export function NewProjectDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: NewProjectValues) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<string>(TEMPLATES[0]);
  const [kind, setKind] = useState<string>(GAME_KINDS[0]);

  if (!open) return null;

  const valid = name.trim().length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('projectDialog.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">
            {t('projectDialog.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit({ name: name.trim(), description: description.trim(), template, kind });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-zinc-300">{t('projectDialog.name')}</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projectDialog.namePlaceholder')}
              maxLength={120}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-zinc-300">
              {t('projectDialog.description')}{' '}
              <span className="font-normal text-zinc-500">({t('common.optional')})</span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('projectDialog.descriptionPlaceholder')}
              maxLength={2000}
              rows={2}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">{t('projectDialog.template')}</span>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              >
                {TEMPLATES.map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {t(`projectDialog.templates.${tpl}`)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">{t('projectDialog.kind')}</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
              >
                {GAME_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {t('projectDialog.cancel')}
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t('projectDialog.creating') : t('projectDialog.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
