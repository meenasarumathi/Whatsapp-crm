"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CheckCircle2,
  CreditCard,
  Headset,
  Loader2,
  Package,
  ReceiptText,
  Sparkles,
  Star,
  UserPlus,
} from "lucide-react"

import { useCan } from "@/hooks/use-can"
import { Button } from "@/components/ui/button"
import type { WorkflowKey } from "@/lib/automations/workflow-library"

const ORDER: WorkflowKey[] = [
  "lead_capture",
  "price_enquiry",
  "order_tracking",
  "human_handoff",
  "payment_reminder",
  "delivery_feedback",
]

const ICON: Record<WorkflowKey, typeof Sparkles> = {
  lead_capture: UserPlus,
  price_enquiry: ReceiptText,
  order_tracking: Package,
  human_handoff: Headset,
  payment_reminder: CreditCard,
  delivery_feedback: Star,
}

interface Status {
  key: WorkflowKey
  installed: boolean
  automations: { id: string; name: string; is_active: boolean }[]
}

export function WorkflowLibrary({ onInstalled }: { onInstalled?: () => void }) {
  const t = useTranslations("Automations.library")
  const router = useRouter()
  const canInstall = useCan("send-messages")
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [busy, setBusy] = useState<WorkflowKey | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automations/library", { cache: "no-store" })
      if (!res.ok) return
      const body = (await res.json()) as { workflows: Status[] }
      setStatus(Object.fromEntries(body.workflows.map((w) => [w.key, w])))
    } catch {
      // Library status is a nicety; cards still work without it.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function install(key: WorkflowKey) {
    setBusy(key)
    try {
      const res = await fetch("/api/automations/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? t("failed"))
      toast.success(t("installed", { name: t(`items.${key}.name`) }))
      await load()
      onInstalled?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" />
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ORDER.map((key) => {
          const Icon = ICON[key]
          const s = status[key]
          const first = s?.automations[0]
          return (
            <div key={key} className="flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{t(`items.${key}.name`)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t(`items.${key}.desc`)}</p>
                </div>
              </div>
              <p className="mt-3 flex-1 text-[11px] leading-relaxed text-muted-foreground">{t(`items.${key}.flow`)}</p>
              <div className="mt-3 flex items-center justify-between gap-2">
                {s?.installed ? (
                  <>
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {s.automations.some((a) => a.is_active) ? t("statusOn") : t("statusDraft")}
                    </span>
                    {first && (
                      <Button size="sm" variant="outline" onClick={() => router.push(`/automations/${first.id}/edit`)}>
                        {t("open")}
                      </Button>
                    )}
                  </>
                ) : (
                  <Button size="sm" className="ml-auto" disabled={!canInstall || busy !== null} onClick={() => void install(key)}>
                    {busy === key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t("install")}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
