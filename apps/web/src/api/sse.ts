import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../types';
import { eventsUrl } from './client';

/**
 * Subscribes to a run's SSE event stream with automatic reconnect.
 *
 * Missed-event replay: the backend exposes stable per-run sequence IDs
 * (`agent_events.seq`, ARCHITECTURE.md §8). Native EventSource already sends
 * `Last-Event-ID` on reconnect; we additionally pass `?lastEventId=` so the
 * server can replay from the exact sequence even across a full reconnect.
 * The running job survives browser loss — the server journal is authoritative.
 */

export function useRunEvents(
  runId: string | null,
  onEvent: (event: AgentEvent, rawKind: string) => void,
): { connected: boolean; lastEventId: string | null } {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const lastIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: number | null = null;
    let backoff = 1000;

    const connect = () => {
      if (disposed) return;
      es?.close();
      setConnected(false);
      es = new EventSource(eventsUrl(runId, lastIdRef.current ?? undefined));

      es.onopen = () => {
        if (!disposed) setConnected(true);
      };

      // The backend sends named events with stable `id:` fields
      // (agent_events.seq). We track the ID so reconnects replay missed events.
      es.onmessage = (msg: MessageEvent) => {
        const id = msg.lastEventId || undefined;
        if (id) lastIdRef.current = id;
        try {
          const payload = JSON.parse(msg.data) as AgentEvent;
          backoff = 1000; // reset backoff on success
          onEventRef.current(payload, 'message');
        } catch {
          /* malformed frame — ignore, keep the stream alive */
        }
      };

      es.onerror = () => {
        es?.close();
        setConnected(false);
        if (disposed) return;
        // Reconnect with exponential backoff (1s → 30s max).
        const delay = Math.min(backoff, 30000);
        backoff = Math.min(backoff * 2, 30000);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      es?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
    // The callback ref pattern keeps the latest onEvent without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { connected, lastEventId: lastIdRef.current };
}
