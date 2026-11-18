import { redirect } from "next/navigation"

// Instagram lives in Settings → Instagram (next to WhatsApp); keep old links working.
export default function InstagramPage() {
  redirect("/settings?tab=instagram")
}
