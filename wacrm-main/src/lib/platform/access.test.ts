import { describe, expect, it } from "vitest";

import {
  ALL_TAB_KEYS,
  allowedTabsFor,
  canAccessTab,
  canChangePlatformUser,
  canCreatePlatformUser,
  effectiveStatus,
  hasActiveAccess,
  normaliseTabs,
  tabForPath,
  trialDaysLeft,
  trialEndsAt,
} from "./access";

const NOW = new Date("2026-10-10T12:00:00Z");

describe("trials", () => {
  it("ends 1 / 7 / 15 days after the start", () => {
    expect(trialEndsAt(1, NOW)).toBe("2026-10-11T12:00:00.000Z");
    expect(trialEndsAt(7, NOW)).toBe("2026-10-17T12:00:00.000Z");
    expect(trialEndsAt(15, NOW)).toBe("2026-10-25T12:00:00.000Z");
  });

  it("reads a lapsed trial as expired without a cron", () => {
    const row = {
      platform_role: "subscriber" as const,
      subscription_status: "trial" as const,
      trial_ends_at: "2026-10-10T11:59:59Z",
    };
    expect(effectiveStatus(row, NOW)).toBe("expired");
    expect(hasActiveAccess(row, NOW)).toBe(false);
    expect(trialDaysLeft(row, NOW)).toBe(0);
  });

  it("counts remaining days rounded up", () => {
    const row = {
      platform_role: "subscriber" as const,
      subscription_status: "trial" as const,
      trial_ends_at: trialEndsAt(7, new Date(NOW.getTime() - 3_600_000)),
    };
    expect(effectiveStatus(row, NOW)).toBe("trial");
    expect(trialDaysLeft(row, NOW)).toBe(7);
  });

  it("never expires or suspends platform admins", () => {
    expect(
      effectiveStatus(
        { platform_role: "admin2", subscription_status: "suspended", trial_ends_at: null },
        NOW,
      ),
    ).toBe("active");
  });
});

describe("tabs", () => {
  it("maps paths to tabs and leaves settings ungated", () => {
    expect(tabForPath("/flows/abc/runs")).toBe("flows");
    expect(tabForPath("/train-ai")).toBe("train-ai");
    expect(tabForPath("/settings")).toBeNull();
    expect(tabForPath("/inboxes")).toBeNull();
  });

  it("treats NULL as every tab and super admin as unrestricted", () => {
    expect(allowedTabsFor({ platform_role: "subscriber", allowed_tabs: null })).toEqual(ALL_TAB_KEYS);
    expect(
      canAccessTab({ platform_role: "super_admin", allowed_tabs: [] }, "inbox"),
    ).toBe(true);
    expect(
      canAccessTab({ platform_role: "subscriber", allowed_tabs: ["inbox"] }, "flows"),
    ).toBe(false);
  });

  it("normalises request input", () => {
    expect(normaliseTabs(["inbox", "bogus", "inbox"])).toEqual(["inbox"]);
    expect(normaliseTabs([...ALL_TAB_KEYS])).toBeNull();
    expect(normaliseTabs(null)).toBeNull();
    expect(normaliseTabs("inbox")).toBeUndefined();
  });
});

describe("who may change what", () => {
  it("lets the super admin manage admins and subscribers, not super admins", () => {
    expect(canChangePlatformUser("super_admin", "admin1", "role")).toBe(true);
    expect(canChangePlatformUser("super_admin", "subscriber", "tabs")).toBe(true);
    expect(canChangePlatformUser("super_admin", "super_admin", "tabs")).toBe(false);
  });

  it("limits Admin 1 to subscribers, without role changes", () => {
    expect(canChangePlatformUser("admin1", "subscriber", "tabs")).toBe(true);
    expect(canChangePlatformUser("admin1", "subscriber", "role")).toBe(false);
    expect(canChangePlatformUser("admin1", "admin2", "trial")).toBe(false);
  });

  it("limits Admin 2 to trials and notes on subscribers", () => {
    expect(canChangePlatformUser("admin2", "subscriber", "trial")).toBe(true);
    expect(canChangePlatformUser("admin2", "subscriber", "status")).toBe(false);
    expect(canChangePlatformUser("admin2", "subscriber", "tabs")).toBe(false);
  });

  it("gates user creation", () => {
    expect(canCreatePlatformUser("super_admin", "admin1")).toBe(true);
    expect(canCreatePlatformUser("admin1", "subscriber")).toBe(true);
    expect(canCreatePlatformUser("admin1", "admin2")).toBe(false);
    expect(canCreatePlatformUser("admin2", "subscriber")).toBe(false);
    expect(canCreatePlatformUser("super_admin", "super_admin")).toBe(false);
  });
});
