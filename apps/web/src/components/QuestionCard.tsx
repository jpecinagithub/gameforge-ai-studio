import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';

/**
 * Renders a durable agent question (SSE `question_asked`) as option cards.
 * Answers are sent back as a normal chat message — the backend resumes the
 * run from the conversation queue (no separate answer endpoint in v1).
 */
export interface QuestionPayload {
  questionId?: string;
  question: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export function QuestionCard({
  payload,
  onAnswer,
  disabled,
}: {
  payload: QuestionPayload;
  onAnswer: (answerText: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      role="group"
      aria-label={t('chat.questionTitle')}
    >
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-300">
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
        {t('chat.questionTitle')}
      </div>
      <p className="mb-3 text-sm text-zinc-200">{payload.question}</p>
      <div className="flex flex-col gap-2">
        {(payload.options ?? []).map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(opt.label)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-200 hover:border-amber-500/50 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="font-medium">{opt.label}</span>
            {opt.description && (
              <span className="block text-xs text-zinc-500">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">{t('chat.questionAnswerAsMessage')}</p>
    </div>
  );
}
