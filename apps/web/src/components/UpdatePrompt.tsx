import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';

/**
 * Safe PWA update prompt: we ask, we never force-reload.
 * A reload mid-run would drop SSE state; the user decides when it's safe.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-cyan-500/30 bg-zinc-950 px-4 py-3 shadow-2xl"
      role="alert"
    >
      <RefreshCw className="h-4 w-4 text-cyan-400" aria-hidden="true" />
      <p className="text-sm text-zinc-200">{t('pwa.updateAvailable')}</p>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="rounded-md bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500"
      >
        {t('pwa.update')}
      </button>
      <button
        type="button"
        onClick={() => setNeedRefresh(false)}
        className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
      >
        {t('pwa.dismiss')}
      </button>
    </div>
  );
}
