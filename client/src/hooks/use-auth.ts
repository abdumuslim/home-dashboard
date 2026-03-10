import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { createElement } from "react";

interface AuthContextValue {
  isAdmin: boolean;
  loading: boolean;
  login(user: string, pass: string): Promise<{ ok: boolean; error?: string }>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isAdmin: false,
  loading: true,
  login: async () => ({ ok: false }),
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data: { authenticated: boolean }) => setIsAdmin(data.authenticated))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (resp.ok && data.ok) {
        setIsAdmin(true);
        return { ok: true };
      }
      return { ok: false, error: data.error ?? "Login failed" };
    } catch {
      return { ok: false, error: "Network error" };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    setIsAdmin(false);
  }, []);

  return createElement(
    AuthContext.Provider,
    { value: { isAdmin, loading, login, logout } },
    children,
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
