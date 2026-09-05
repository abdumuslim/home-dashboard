import { useEffect, useState } from "react";
import { ShieldAlert, Loader2, RefreshCw } from "lucide-react";
import type { AuthState } from "@/hooks/use-devices";

/**
 * Mirrors the server's global relogin cooldown (routes.ts): every accepted retry
 * costs a fresh Xiaomi login, and login volume is what earns a captcha. The button
 * holds itself shut for the window instead of letting a click storm reach the 429.
 */
const RELOGIN_COOLDOWN_SECS = 60;

interface XiaomiVerifyPromptProps {
  authState: AuthState;
  onSubmit: (code: string) => Promise<{ ok: boolean; error?: string }>;
  onRelogin: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Xiaomi Cloud login challenges arrive on the server and used to be answerable only by curl.
 * This is the browser side of POST /api/xiaomi/verify (and the relogin recovery button).
 */
export function XiaomiVerifyPrompt({ authState, onSubmit, onRelogin }: XiaomiVerifyPromptProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloginCooldown, setReloginCooldown] = useState(0);

  // Tick the retry countdown down to zero; the cleanup also stops it on unmount.
  useEffect(() => {
    if (reloginCooldown <= 0) return;
    const timer = setTimeout(() => setReloginCooldown((secs) => secs - 1), 1000);
    return () => clearTimeout(timer);
  }, [reloginCooldown]);

  const needsCode = authState.status === "needs_2fa" || authState.status === "needs_captcha";
  const failed = authState.status === "error";
  if (!needsCode && !failed) return null;

  const captchaSrc = authState.captchaImage
    ? authState.captchaImage.startsWith("data:")
      ? authState.captchaImage
      : `data:image/png;base64,${authState.captchaImage}`
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    // Belt and braces with the hook's own catch: this is the 2FA recovery path, so a
    // rejected submit must still release the button instead of disabling it until a remount.
    try {
      const result = await onSubmit(trimmed);
      if (result.ok) setCode("");
      else setError(result.error ?? "Verification failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRelogin = async () => {
    if (busy || reloginCooldown > 0) return;
    setBusy(true);
    setError("");
    const result = await onRelogin();
    // A 429 body says when the next retry is allowed; show it instead of failing silently.
    if (!result.ok) setError(result.error ?? "Sign-in retry failed");
    setBusy(false);
    // An accepted retry started the server's window and a refused one collided with
    // it, so either way the next click has to wait.
    setReloginCooldown(RELOGIN_COOLDOWN_SECS);
  };

  return (
    <div className="glass-card mb-3 flex flex-wrap items-center gap-2.5 px-4 py-2.5 border-amber-400/30 animate-fade-in">
      <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
      <span className="text-sm text-text">
        {authState.status === "needs_captcha"
          ? "Purifiers: Xiaomi Cloud needs a captcha"
          : needsCode
            ? "Purifiers: Xiaomi Cloud needs a verification code"
            : "Purifiers: Xiaomi Cloud sign-in failed"}
      </span>

      {captchaSrc && (
        <img src={captchaSrc} alt="Captcha" className="h-8 rounded-lg border border-white/10 bg-white/90" />
      )}

      {needsCode ? (
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={authState.status === "needs_captcha" ? "Captcha" : "Code"}
            autoComplete="one-time-code"
            className="w-28 rounded-full bg-white/5 border border-white/10 px-3 py-1 text-sm text-text outline-none focus:border-cyan/50 transition-colors"
          />
          <button
            type="submit"
            disabled={!code.trim() || busy}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Verify
          </button>
        </form>
      ) : (
        <button
          onClick={handleRelogin}
          disabled={busy || reloginCooldown > 0}
          className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-cyan/20 text-cyan hover:bg-cyan/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {reloginCooldown > 0 ? `Retry in ${reloginCooldown}s` : "Retry Sign-In"}
        </button>
      )}

      {(error || authState.error) && (
        <span className="text-xs text-red-400">{error || authState.error}</span>
      )}
    </div>
  );
}
