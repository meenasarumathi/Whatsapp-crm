"use client";

// Support — users raise complaints, platform admins resolve them.
// See src/components/support/support-center.tsx and /api/support.

import { Suspense } from "react";
import { Loader2 } from "lucide-react";

import { SupportCenter } from "@/components/support/support-center";

export default function SupportPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* useSearchParams (?t=<ticket id>) needs a Suspense boundary. */}
      <Suspense fallback={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}>
        <SupportCenter />
      </Suspense>
    </div>
  );
}
