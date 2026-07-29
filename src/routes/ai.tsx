import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

export const Route = createFileRoute('/ai')({
    component: AiChat,
});

const MODELS = [
    { label: 'GPT-5.2', value: 'gpt-5.2' },
    { label: 'GPT-5.2 Pro', value: 'gpt-5.2-pro' },
    { label: 'GPT-5.1', value: 'gpt-5.1' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-5 Mini', value: 'gpt-5-mini' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'GPT-4.1 Mini', value: 'gpt-4.1-mini' },
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
] as const;

function AiChat() {
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState<string>(MODELS[0].value);
    const [prompt, setPrompt] = useState('');
    const [stream, setStream] = useState(true);
    const [output, setOutput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSend = async () => {
        if (!apiKey || !prompt) return;
        setLoading(true);
        setError(null);
        setOutput('');

        const id = crypto.randomUUID();

        if (stream) {
            const offChunk = window.electron.onAiChunk((data) => {
                if (data.id !== id) return;
                setOutput((prev) => prev + data.delta);
            });
            const offDone = window.electron.onAiDone((data) => {
                if (data.id !== id) return;
                setLoading(false);
                cleanup();
            });
            const offError = window.electron.onAiError((data) => {
                if (data.id !== id) return;
                setError(data.message);
                setLoading(false);
                cleanup();
            });
            const cleanup = () => {
                offChunk();
                offDone();
                offError();
            };

            await window.electron.aiChat({ id, apiKey, model, prompt, stream: true });
            return;
        }

        const result = await window.electron.aiChat({ id, apiKey, model, prompt, stream: false });
        setLoading(false);
        if (result?.error) {
            setError(result.error);
        } else {
            setOutput(result?.text ?? '');
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <div className="mx-auto w-full max-w-2xl space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>🤖 TanStack AI</CardTitle>
                        <CardDescription>
                            OpenAI chat via @tanstack/ai, streamed straight from the Electron main process.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="apiKey">OpenAI API key</Label>
                            <Input
                                id="apiKey"
                                type="password"
                                placeholder="sk-..."
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="model">Model</Label>
                            <Select value={model} onValueChange={setModel}>
                                <SelectTrigger id="model">
                                    <SelectValue placeholder="Select model" />
                                </SelectTrigger>
                                <SelectContent>
                                    {MODELS.map((m) => (
                                        <SelectItem key={m.value} value={m.value}>
                                            {m.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="prompt">Prompt</Label>
                            <Textarea
                                id="prompt"
                                placeholder="Ask something..."
                                rows={4}
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <Label htmlFor="stream">Stream response</Label>
                            <Switch id="stream" checked={stream} onCheckedChange={setStream} />
                        </div>

                        <Button
                            className="w-full"
                            onClick={handleSend}
                            disabled={loading || !apiKey || !prompt}
                        >
                            {loading ? 'Sending...' : 'Send'}
                        </Button>

                        {error && (
                            <Alert variant="destructive">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="output">Output</Label>
                            <Textarea id="output" readOnly rows={8} value={output} />
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
