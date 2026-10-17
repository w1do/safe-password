import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dashboard } from '@/components/Dashboard';
import { LoginPage } from '@/components/LoginPage';
import { NewTokenDialog } from '@/components/NewTokenDialog';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api, setUnauthorizedHandler } from '@/lib/api';

type AuthState = { kind: 'loading' } | { kind: 'anonymous' } | { kind: 'signed-in'; email: string };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });
  // Lives above the auth state: rotating the token ends the session, but the new token must still be shown.
  const [newToken, setNewToken] = useState<string | null>(null);

  const signOut = useCallback(() => setAuth({ kind: 'anonymous' }), []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    api
      .me()
      .then(({ email }) => setAuth({ kind: 'signed-in', email }))
      .catch(() => setAuth({ kind: 'anonymous' }));
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  return (
    <TooltipProvider delayDuration={300}>
      {auth.kind === 'loading' && (
        <div className="flex min-h-screen items-center justify-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
      {auth.kind === 'anonymous' && <LoginPage onLoggedIn={(email) => setAuth({ kind: 'signed-in', email })} />}
      {auth.kind === 'signed-in' && (
        <Dashboard
          email={auth.email}
          onSignedOut={signOut}
          onTokenRotated={(token) => {
            setNewToken(token);
            signOut();
          }}
        />
      )}
      <NewTokenDialog token={newToken} onDone={() => setNewToken(null)} />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
