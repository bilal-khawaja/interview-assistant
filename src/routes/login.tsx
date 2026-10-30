import { createFileRoute } from '@tanstack/react-router';
import { Eye, EyeOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { authStore, useAuth } from '@/lib/auth-client';
import { transcriptStore, useMeetings } from '@/lib/transcript-client';
import type { AuthState } from '@/types/auth';

export const Route = createFileRoute('/login')({
    component: LoginPage,
});

const MIN_PASSWORD_LENGTH = 8;

/** Why the person is looking at this screen, when it is not simply a fresh start. */
function notice(auth: AuthState, backendUrl: string): string | null {
    if (auth.status !== 'signedOut') return null;
    if (auth.reason === 'expired') return 'Your session ended. Sign in again to continue.';
    if (auth.reason === 'unreachable') return `Cannot reach the backend at ${backendUrl}. Check the address below, then try again.`;
    return null;
}

function LoginPage() {
    const { auth, busy, error } = useAuth();
    const meetings = useMeetings();
    const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [address, setAddress] = useState(meetings.backendUrl);
    const [addressMessage, setAddressMessage] = useState<string | null>(null);
    const signUp = mode === 'sign-up';
    const reason = notice(auth, meetings.backendUrl);
    const shortPassword = signUp && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (signUp) void authStore.signUp({ name, email, password });
        else void authStore.signIn({ email, password });
    };

    const saveAddress = async () => {
        setAddressMessage(null);
        // The meeting list needs a signed-in user, so only the address is applied here.
        const failure = await transcriptStore.setBackendUrl(address, { refresh: false });
        if (failure) {
            setAddressMessage(failure);
            return;
        }
        setAddress(transcriptStore.getState().backendUrl);
        await authStore.refresh();
    };

    const switchMode = () => {
        setMode(signUp ? 'sign-in' : 'sign-up');
        authStore.clearError();
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>{signUp ? 'Create an account' : 'Sign in'}</CardTitle>
                    <CardDescription>
                        {signUp
                            ? 'Your meetings and chats belong to your account.'
                            : 'Sign in to see your meetings and chats.'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {reason && (
                        <Alert>
                            <AlertDescription>{reason}</AlertDescription>
                        </Alert>
                    )}
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}
                    <form className="space-y-3" onSubmit={submit}>
                        {signUp && (
                            <div className="space-y-1.5">
                                <Label htmlFor="auth-name">Name</Label>
                                <Input
                                    id="auth-name"
                                    autoComplete="name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </div>
                        )}
                        <div className="space-y-1.5">
                            <Label htmlFor="auth-email">Email</Label>
                            <Input
                                id="auth-email"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="auth-password">Password</Label>
                            <div className="relative">
                                <Input
                                    id="auth-password"
                                    type={showPassword ? 'text' : 'password'}
                                    autoComplete={signUp ? 'new-password' : 'current-password'}
                                    className="pr-10"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="absolute right-0 top-0 text-muted-foreground"
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    aria-pressed={showPassword}
                                    onClick={() => setShowPassword((v) => !v)}
                                >
                                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                </Button>
                            </div>
                            {shortPassword && (
                                <p className="text-xs text-muted-foreground">
                                    Use at least {MIN_PASSWORD_LENGTH} characters.
                                </p>
                            )}
                        </div>
                        <Button
                            type="submit"
                            className="w-full"
                            disabled={busy || !email.trim() || !password || (signUp && (!name.trim() || shortPassword))}
                        >
                            {busy && <Spinner className="mr-2 size-4" />}
                            {signUp ? 'Create account' : 'Sign in'}
                        </Button>
                    </form>
                    <button
                        type="button"
                        className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
                        onClick={switchMode}
                    >
                        {signUp ? 'I already have an account' : 'Create an account'}
                    </button>

                    <details className="border-t pt-3 text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">Backend address</summary>
                        <div className="mt-2 space-y-2">
                            <Input
                                aria-label="Backend address"
                                value={address}
                                placeholder="http://localhost:3000"
                                onChange={(e) => setAddress(e.target.value)}
                            />
                            {addressMessage && <p className="text-destructive">{addressMessage}</p>}
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy || !address.trim()}
                                onClick={() => void saveAddress()}
                            >
                                Save and retry
                            </Button>
                        </div>
                    </details>
                </CardContent>
            </Card>
        </div>
    );
}
