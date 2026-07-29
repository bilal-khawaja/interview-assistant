import { useRef, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useRealtimeChat } from '@tanstack/ai-react';
import { openaiRealtime } from '@tanstack/ai-openai';
import type { UsageInfo } from '@tanstack/ai';
import { tipcInvoker } from '@/lib/tipc-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

export const Route = createFileRoute('/realtime')({
    component: RealtimePage,
});

const REALTIME_MODELS = [
    { label: 'GPT Realtime', value: 'gpt-realtime' },
    { label: 'GPT Realtime Mini', value: 'gpt-realtime-mini' },
] as const;

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

const DEFAULT_INSTRUCTIONS =
    'You are a helpful interview assistant. Keep responses concise and speak naturally.';

function formatCost(usage: UsageInfo | null): string {
    if (!usage?.costDetails?.upstreamCost) return '—';
    return `$${usage.costDetails.upstreamCost.toFixed(4)}`;
}

function RealtimePage() {
    const [model, setModel] = useState<string>(REALTIME_MODELS[0].value);
    const [voice, setVoice] = useState<string>(VOICES[0]);
    const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);

    const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
    const [totalUsage, setTotalUsage] = useState({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });

    // `useRealtimeChat` freezes `getToken`/`instructions`/`voice` from its
    // first-render closure — later state updates never reach them directly.
    // Route the live values through a ref so the frozen closure still reads
    // current data at connect time.
    const modelRef = useRef(model);
    modelRef.current = model;

    const {
        status,
        mode,
        messages,
        connect,
        disconnect,
        pendingUserTranscript,
        pendingAssistantTranscript,
        updateSession,
        inputLevel,
        error,
    } = useRealtimeChat({
        getToken: () => tipcInvoker.ai.realtimeToken({ model: modelRef.current }),
        adapter: openaiRealtime(),
        instructions,
        voice,
        onUsage: (usage) => {
            setLastUsage(usage);
            setTotalUsage((prev) => ({
                promptTokens: prev.promptTokens + usage.promptTokens,
                completionTokens: prev.completionTokens + usage.completionTokens,
                totalTokens: prev.totalTokens + usage.totalTokens,
                cost: prev.cost + (usage.costDetails?.upstreamCost ?? 0),
            }));
        },
    });

    const handleConnect = async () => {
        await connect();
        // instructions/voice are also frozen from the hook's first-render
        // closure — push whatever the user has set right now.
        updateSession({ instructions, voice });
    };

    const transcript = [
        ...messages.flatMap((m) =>
            m.parts
                .filter((p): p is Extract<typeof p, { type: 'text' | 'audio' }> => p.type === 'text' || p.type === 'audio')
                .map((p) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${p.type === 'text' ? p.content : p.transcript}`),
        ),
        pendingUserTranscript ? `You: ${pendingUserTranscript}` : null,
        pendingAssistantTranscript ? `Assistant: ${pendingAssistantTranscript}` : null,
    ]
        .filter(Boolean)
        .join('\n');

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <div className="mx-auto w-full max-w-2xl space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>🎙️ Realtime Voice Chat</CardTitle>
                        <CardDescription>
                            OpenAI Realtime over WebRTC — live transcript, running token/cost meter.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="model">Model</Label>
                                <Select value={model} onValueChange={setModel} disabled={status !== 'idle'}>
                                    <SelectTrigger id="model">
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {REALTIME_MODELS.map((m) => (
                                            <SelectItem key={m.value} value={m.value}>
                                                {m.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="voice">Voice</Label>
                                <Select value={voice} onValueChange={setVoice} disabled={status !== 'idle'}>
                                    <SelectTrigger id="voice">
                                        <SelectValue placeholder="Select voice" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {VOICES.map((v) => (
                                            <SelectItem key={v} value={v}>
                                                {v}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="instructions">System instructions</Label>
                            <Textarea
                                id="instructions"
                                rows={3}
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                disabled={status !== 'idle'}
                            />
                        </div>

                        <Button
                            className="w-full"
                            onClick={status === 'idle' ? handleConnect : disconnect}
                        >
                            {status === 'idle' ? 'Connect' : status === 'connecting' ? 'Connecting...' : 'Disconnect'}
                        </Button>

                        <div className="text-sm text-muted-foreground">
                            Status: {status} · Mode: {mode}
                            {mode === 'listening' && (
                                <span className="ml-2 inline-flex items-center gap-1 align-middle">
                                    🎤
                                    <span className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                                        <span
                                            className="block h-full rounded-full bg-primary transition-[width] duration-75"
                                            style={{ width: `${Math.round(inputLevel * 100)}%` }}
                                        />
                                    </span>
                                </span>
                            )}
                        </div>

                        {error && (
                            <Alert variant="destructive">
                                <AlertDescription>{error.message}</AlertDescription>
                            </Alert>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="transcript">Live transcript</Label>
                            <Textarea id="transcript" readOnly rows={8} value={transcript} />
                        </div>

                        <div className="grid grid-cols-2 gap-4 rounded-md border p-3 text-sm">
                            <div>
                                <div className="font-medium">Last response</div>
                                <div>
                                    {lastUsage
                                        ? `${lastUsage.promptTokens}+${lastUsage.completionTokens}=${lastUsage.totalTokens} tok · ${formatCost(lastUsage)}`
                                        : '—'}
                                </div>
                            </div>
                            <div>
                                <div className="font-medium">Session total</div>
                                <div>
                                    {totalUsage.totalTokens} tok · ${totalUsage.cost.toFixed(4)}
                                </div>
                            </div>
                        </div>

                        <Link to="/">
                            <Button variant="outline" className="w-full">
                                Back to home
                            </Button>
                        </Link>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
