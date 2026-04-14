"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TelemetryEvent } from "@the-council/contracts";
import { TelemetryEventCard } from "./telemetry-event-card";
import { TelemetryFilters, applyFilters, defaultFilters } from "./telemetry-filters";
import type { TelemetryFilterState } from "./telemetry-filters";

const MAX_VISIBLE = 200;

export function TelemetryStream({ events, title = "Telemetry" }: { events: TelemetryEvent[]; title?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [filters, setFilters] = useState<TelemetryFilterState>(defaultFilters);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const lastAnnouncedRef = useRef<number>(-1);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = applyFilters(events, filters);
  const visible = filtered.slice(-MAX_VISIBLE);

  // Auto-scroll to bottom when new events arrive and user is at bottom
  useEffect(() => {
    if (!isAtBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visible.length, isAtBottom]);

  // Rate-limited ARIA announcements (1/second)
  useEffect(() => {
    const latest = visible[visible.length - 1];
    if (!latest || latest.sequence === lastAnnouncedRef.current) return;
    if (announceTimerRef.current) return;
    announceTimerRef.current = setTimeout(() => {
      if (liveRegionRef.current) {
        liveRegionRef.current.textContent = latest.message;
      }
      lastAnnouncedRef.current = latest.sequence;
      announceTimerRef.current = null;
    }, 1000);
    return () => {
      if (announceTimerRef.current) {
        clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
  }, [visible]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsAtBottom(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs font-mono text-cyan-400 px-2 pt-2">{title}</div>
      <TelemetryFilters events={events} filters={filters} onFiltersChange={setFilters} />
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          {filtered.length > MAX_VISIBLE && (
            <div className="text-center py-2">
              <button
                onClick={() => {/* Load earlier - could expand in future */}}
                className="text-xs text-gray-500 hover:text-gray-300 font-mono"
              >
                Showing last {MAX_VISIBLE} of {filtered.length} events
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <div className="text-xs text-gray-600 text-center py-4 font-mono">— no events —</div>
          ) : (
            visible.map((event) => <TelemetryEventCard key={event.id} event={event} />)
          )}
        </div>
        {!isAtBottom && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-2 right-2 bg-cyan-900 text-cyan-300 text-xs px-3 py-1 rounded font-mono hover:bg-cyan-800"
          >
            ↓ Latest
          </button>
        )}
      </div>
      {/* ARIA live region for screen readers */}
      <div
        ref={liveRegionRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </div>
  );
}
