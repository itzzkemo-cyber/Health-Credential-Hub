import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  login as apiLogin,
  demoLogin as apiDemoLogin,
  register as apiRegister,
  logout as apiLogout,
  totpChallenge as apiTotpChallenge,
  getMe,
  ApiError,
} from '@workspace/api-client-react';
import type { User, DemoLoginInputRole, RegisterInput } from '@workspace/api-client-react';
import {
  configureApiClient,
  getStoredToken,
  storeToken,
  clearStoredToken,
  setUnauthorizedHandler,
} from '@/lib/api';

// Make sure the API client is configured before any request fires.
configureApiClient();

/** Password accepted but the account has 2FA — finish with completeTwoFactor. */
export type LoginResult =
  | { pending2fa: true; challengeToken: string }
  | { pending2fa: false };

interface AuthContextType {
  currentUser: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  demoLogin: (role: DemoLoginInputRole) => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  // Mirror of currentUser for the global 401 handler (avoids stale closures).
  const currentUserRef = useRef<User | null>(null);
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // Session rejected mid-use (expired/revoked token → any request answers
  // 401): drop the session and land on the login screen, from any screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // A failed login attempt also yields 401 — only react when someone
      // is actually signed in, so we never loop on the login screen itself.
      if (!currentUserRef.current) return;
      currentUserRef.current = null;
      void clearStoredToken();
      setCurrentUser(null);
      queryClient.clear();
      router.replace('/(auth)/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  // Restore the session on app start: if a token is stored, ask the server
  // who we are. An invalid/expired token is discarded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getStoredToken();
        if (!token) return;
        const user = await getMe();
        if (!cancelled) setCurrentUser(user);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          await clearStoredToken();
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applySession = useCallback(
    async (token: string, user: User) => {
      await storeToken(token);
      queryClient.clear();
      setCurrentUser(user);
    },
    [queryClient],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await apiLogin({ email, password });
      if ('pending2fa' in res) {
        return { pending2fa: true, challengeToken: res.challengeToken };
      }
      await applySession(res.token, res.user);
      return { pending2fa: false };
    },
    [applySession],
  );

  const completeTwoFactor = useCallback(
    async (challengeToken: string, code: string) => {
      const res = await apiTotpChallenge({ challengeToken, code });
      await applySession(res.token, res.user);
    },
    [applySession],
  );

  const demoLogin = useCallback(
    async (role: DemoLoginInputRole) => {
      const res = await apiDemoLogin({ role });
      await applySession(res.token, res.user);
    },
    [applySession],
  );

  const register = useCallback(
    async (data: RegisterInput) => {
      const res = await apiRegister(data);
      await applySession(res.token, res.user);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Token is discarded locally either way.
    }
    await clearStoredToken();
    setCurrentUser(null);
    queryClient.clear();
  }, [queryClient]);

  return (
    <AuthContext.Provider
      value={{ currentUser, isLoading, login, completeTwoFactor, demoLogin, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
