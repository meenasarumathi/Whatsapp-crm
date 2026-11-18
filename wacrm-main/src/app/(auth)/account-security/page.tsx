"use client";

// Where a signed-in but restricted session finishes set-up before using the
// app: change a temporary password, then (Super Admin / Admin) set up
// two-step verification. The API refuses every other endpoint until this is
// done; this page only guides the user through it.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, Loader2, LogOut, ShieldCheck } from "lucide-react";

import { AuthShell } from "@/components/brand/auth-shell";
import { MfaSetup } from "@/components/auth/mfa-setup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Restriction = "password_change" | "mfa_enrollment";

export default function AccountSecurityPage() {
  const t = useTranslations("AccountSecurity");
  const [restrictions, setRestrictions] = useState<Restriction[] | null>(null);
  const [email, setEmail] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as {
      user?: unknown;
      restrictions?: Restriction[];
      pending?: { email?: string };
    };
    const r = json.restrictions ?? [];
    if (!r.length) {
      window.location.replace(json.user ? "/dashboard" : "/login");
      return;
    }
    setEmail(json.pending?.email ?? "");
    setRestrictions(r);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  };

  const step = restrictions?.[0];

  return (
    <AuthShell>
      <Card className="w-full border-border bg-card/80 shadow-xl shadow-black/10 backdrop-blur">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {step === "password_change" ? (
              <KeyRound className="h-6 w-6 text-primary" />
            ) : (
              <ShieldCheck className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {step === "password_change" ? t("password.title") : t("mfa.title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {step === "password_change" ? t("password.description") : t("mfa.mandatoryDescription")}
            {email && <span className="mt-1 block text-xs">{email}</span>}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!restrictions && (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {step === "password_change" && <TempPasswordChange onDone={() => void load()} />}
          {step === "mfa_enrollment" && <MfaSetup onDone={() => void load()} />}
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <LogOut className="size-4" />
            {t("signOut")}
          </button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function TempPasswordChange({ onDone }: { onDone: () => void }) {
  const t = useTranslations("AccountSecurity.password");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(t("mismatch"));
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current, next }),
      credentials: "same-origin",
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return setError(j.error?.message ?? t("failed"));
    }
    onDone();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="cur" className="text-muted-foreground">{t("current")}</Label>
        <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="new" className="text-muted-foreground">{t("new")}</Label>
        <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm" className="text-muted-foreground">{t("confirm")}</Label>
        <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t("submit")}
      </Button>
    </form>
  );
}
