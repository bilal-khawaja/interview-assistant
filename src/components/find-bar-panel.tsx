import { useEffect, type RefObject } from 'react';
import { X, ChevronUp, ChevronDown } from 'lucide-react';
import type { FindEngine } from '@/lib/find-engine';

export function FindBarPanel({
    engine,
    query,
    setQuery,
    onClose,
    inputRef,
}: {
    engine: FindEngine;
    query: string;
    setQuery: (q: string) => void;
    onClose: () => void;
    inputRef: RefObject<HTMLInputElement | null>;
}) {
    useEffect(() => {
        inputRef.current?.focus();
    }, [inputRef]);

    return (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-white/10 bg-[#1c1c1e]/95 px-2 py-1.5 shadow-lg">
            <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    engine.search(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.shiftKey ? engine.prev() : engine.next();
                    } else if (e.key === 'Escape') {
                        onClose();
                    }
                }}
                placeholder="Find in page..."
                className="w-40 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
            />
            {engine.result && (
                <span className="shrink-0 text-xs tabular-nums text-white/40">
                    {engine.result.matches === 0
                        ? '0/0'
                        : `${engine.result.activeMatchOrdinal}/${engine.result.matches}`}
                </span>
            )}
            <button
                type="button"
                aria-label="Previous match"
                onClick={engine.prev}
                disabled={!query}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
                <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                aria-label="Next match"
                onClick={engine.next}
                disabled={!query}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
                <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white"
            >
                <X className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}
