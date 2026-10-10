"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import type { TrainingProfile } from "@/lib/ai/training";

export interface TrainingRow {
  id: string;
  kind: "qa" | "rule";
  question: string | null;
  answer: string;
  category: string | null;
  source: "manual" | "conversation" | "import";
  is_active: boolean;
  use_count: number;
  created_at: string;
}

export interface TrainingData {
  loading: boolean;
  /** False when migration 044 hasn't been applied yet. */
  ready: boolean;
  profile: TrainingProfile;
  rows: TrainingRow[];
  knowledgeDocs: number;
  aiConfigured: boolean;
  aiActive: boolean;
  autoReply: boolean;
  hasEmbeddingsKey: boolean;
  reload: () => Promise<void>;
  setProfile: (p: TrainingProfile) => void;
}

/** Everything the Train AI page shows, read straight from Supabase (RLS-scoped). */
export function useTraining(): TrainingData {
  const { accountId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(true);
  const [profile, setProfile] = useState<TrainingProfile>({});
  const [rows, setRows] = useState<TrainingRow[]>([]);
  const [knowledgeDocs, setKnowledgeDocs] = useState(0);
  const [ai, setAi] = useState({
    configured: false,
    active: false,
    autoReply: false,
    embeddings: false,
  });

  const reload = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const [profileRes, rowsRes, docsRes, configRes] = await Promise.all([
      supabase.from("ai_training_profiles").select("profile").eq("account_id", accountId).maybeSingle(),
      supabase
        .from("ai_training_examples")
        .select("id, kind, question, answer, category, source, is_active, use_count, created_at")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(2000),
      supabase
        .from("ai_knowledge_documents")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId),
      fetch("/api/ai/config")
        .then((r) => r.json())
        .catch(() => ({})),
    ]);
    const missing = (code?: string) => code === "42P01" || code === "PGRST205";
    setReady(!missing(profileRes.error?.code) && !missing(rowsRes.error?.code));
    setProfile((profileRes.data?.profile as TrainingProfile | undefined) ?? {});
    setRows((rowsRes.data as TrainingRow[] | null) ?? []);
    setKnowledgeDocs(docsRes.count ?? 0);
    setAi({
      configured: !!configRes?.configured,
      active: !!configRes?.is_active,
      autoReply: !!configRes?.auto_reply_enabled,
      embeddings: !!configRes?.has_embeddings_key,
    });
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return {
    loading,
    ready,
    profile,
    rows,
    knowledgeDocs,
    aiConfigured: ai.configured,
    aiActive: ai.active,
    autoReply: ai.autoReply,
    hasEmbeddingsKey: ai.embeddings,
    reload,
    setProfile,
  };
}
