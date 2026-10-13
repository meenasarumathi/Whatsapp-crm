"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";

export interface WalletRequest {
  id: string;
  amount_paise: number;
  tokens_units: number;
  rate_tokens_per_rupee_num: number;
  rate_tokens_per_rupee_den: number;
  status: "pending" | "approved" | "rejected";
  payment_reference: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  has_proof: boolean;
}

export interface WalletLedgerRow {
  id: string;
  entry_type: string;
  amount_units: number;
  balance_after_units: number;
  reason: string | null;
  reference: string | null;
  created_at: string;
}

export interface WalletData {
  balance_units: number;
  /** The platform owner's account (super admin) — never charged. */
  unlimited?: boolean;
  paused: boolean;
  is_owner: boolean;
  is_wallet_admin: boolean;
  is_super_admin: boolean;
  settings?: {
    rate_num: number;
    rate_den: number;
    gpay_upi_id: string | null;
    gpay_payee_name: string | null;
    gpay_instructions: string | null;
  } | null;
  requests?: WalletRequest[];
  ledger?: WalletLedgerRow[];
  usage_30d?: Record<string, number>;
  features?: { feature: string; enabled: boolean }[];
}

interface WalletContextValue {
  loading: boolean;
  /** Null until loaded, or when the wallet isn't set up (migration 045). */
  data: WalletData | null;
  notMigrated: boolean;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const REFRESH_MS = 60_000;

/** One shared wallet fetch for the sidebar, banner, dashboard and wallet page. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<WalletData | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setData(json as WalletData);
        setNotMigrated(false);
      } else {
        setData(null);
        setNotMigrated(json?.code === "not_migrated");
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [user, refresh]);

  return (
    <WalletContext.Provider value={{ loading, data, notMigrated, refresh }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
