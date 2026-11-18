"use client";

// Users — platform user management (Super admin / Admin 1 / Admin 2).
// Same panel as Settings → Subscription users, given its own sidebar tab.
// Who may see and change what is enforced by /api/platform/users.

import { SubscriptionUsersPanel } from "@/components/settings/subscription-users-panel";

export default function UsersPage() {
  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <SubscriptionUsersPanel />
    </div>
  );
}
