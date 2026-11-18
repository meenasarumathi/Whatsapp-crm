"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { AutoRepliesManager } from "@/components/auto-replies/auto-replies-manager"

export default function AutoRepliesPage() {
  const t = useTranslations("AutoReplies")
  return (
    <div className="space-y-6">
      <div>
        <Link href="/automations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" />
          {t("back")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <AutoRepliesManager />
    </div>
  )
}
