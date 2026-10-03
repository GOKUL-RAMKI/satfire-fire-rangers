import { useState, type FormEvent } from "react";
import { api, errorText, type User } from "../lib/api";

export default function LoginPage({ onLogin, notice }: { onLogin: (u: User) => void; notice?: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLogin(await api.login(username, password));
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-4 text-ink">
      <form onSubmit={submit} className="w-full max-w-sm rounded border border-rule bg-card p-6" aria-labelledby="login-title">
        <div className="font-mono text-lg font-semibold tracking-tight">SATFIRE</div>
        <h1 id="login-title" className="mb-4 text-xs text-mute">
          Operator sign-in — the dashboard shows industrial-site data and requires login.
        </h1>
        {notice && <div className="mb-3 rounded bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-600/30">{notice}</div>}
        <label htmlFor="username" className="block font-mono text-[10px] uppercase text-mute">
          Username
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-3 mt-1 w-full border border-rule bg-paper px-2 py-1.5 text-sm focus:border-ink focus:outline-none"
        />
        <label htmlFor="password" className="block font-mono text-[10px] uppercase text-mute">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 mt-1 w-full border border-rule bg-paper px-2 py-1.5 text-sm focus:border-ink focus:outline-none"
        />
        {err && (
          <div className="mb-3 text-xs text-red-800" role="alert">
            {err}
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full border border-ink bg-ink px-3 py-2 font-mono text-xs uppercase text-paper hover:bg-ink/90 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
