"use client";

import { motion } from "framer-motion";
import type { LoginState } from "../lib/types/bridge";
import { CockpitScene } from "./cockpit-scene";

export function LoginScreen({
  loginState,
  setLoginState,
  busy,
  error,
  onLogin
}: {
  loginState: LoginState;
  setLoginState: (updater: (state: LoginState) => LoginState) => void;
  busy: string | null;
  error: string | null;
  onLogin: () => void;
}) {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <CockpitScene />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(118,244,255,0.15),transparent_50%)]" />
      <section className="relative z-10 flex min-h-screen items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          className="panel w-full max-w-md rounded-[2rem] p-8 shadow-bridge"
        >
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="panel-title text-glow">The Council</p>
              <h1 className="mt-2 text-3xl font-semibold text-white">Bridge Authorization</h1>
            </div>
            <div className="status-dot bg-glow text-glow" />
          </div>
          <p className="mb-6 text-sm text-slate-300">
            Authenticate as the captain to unlock mission workspaces, crew orchestration, and live telemetry.
          </p>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Operator</span>
              <input
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-glow"
                value={loginState.username}
                onChange={(event) => setLoginState((state) => ({ ...state, username: event.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400">Passphrase</span>
              <input
                type="password"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-amber"
                value={loginState.password}
                onChange={(event) => setLoginState((state) => ({ ...state, password: event.target.value }))}
              />
            </label>
            <button
              type="button"
              onClick={onLogin}
              disabled={busy === "login"}
              data-testid="login-submit"
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-300 px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-950 transition hover:brightness-110 disabled:opacity-60"
            >
              {busy === "login" ? "Synchronizing" : "Enter Bridge"}
            </button>
            {error ? <p className="text-sm text-rose-300">{error}</p> : null}
          </div>
        </motion.div>
      </section>
    </main>
  );
}
