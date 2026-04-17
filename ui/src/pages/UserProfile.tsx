// AgentDash: UserProfile — identity, preferences, and account danger zone.
//
// Scope: this page renders the authenticated user's identity (from the
// BetterAuth session), a preferences form (timezone + email notifications
// persisted to localStorage under `agentdash.user.preferences`), and a
// danger-zone block. API-key management and self-service account deletion
// are NOT implemented here because no backend routes exist for them yet.
// See `ui/src/api/user-profile.ts` for the scope note.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserCircle, Mail, Globe, Bell, AlertTriangle } from "lucide-react";

import { userProfileApi, type UserProfile as UserProfileType } from "../api/user-profile";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Preferences (localStorage-backed — no backend persistence exists yet)
// ---------------------------------------------------------------------------

const PREFS_KEY = "agentdash.user.preferences";

interface UserPreferences {
  timezone: string;
  emailNotifications: boolean;
  inAppNotifications: boolean;
}

const DEFAULT_PREFS: UserPreferences = {
  timezone:
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : "UTC",
  emailNotifications: true,
  inAppNotifications: true,
};

// A short list of common IANA timezones. This is deliberately not exhaustive —
// exotic zones can be entered via a settings tool later.
const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function loadPreferences(): UserPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UserPreferences> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    return {
      timezone:
        typeof parsed.timezone === "string" && parsed.timezone.trim().length > 0
          ? parsed.timezone
          : DEFAULT_PREFS.timezone,
      emailNotifications:
        typeof parsed.emailNotifications === "boolean"
          ? parsed.emailNotifications
          : DEFAULT_PREFS.emailNotifications,
      inAppNotifications:
        typeof parsed.inAppNotifications === "boolean"
          ? parsed.inAppNotifications
          : DEFAULT_PREFS.inAppNotifications,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePreferences(prefs: UserPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore write errors — localStorage may be disabled in some browsers
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UserProfile() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();

  useEffect(() => {
    setBreadcrumbs([{ label: "Profile" }]);
  }, [setBreadcrumbs]);

  const meQuery = useQuery({
    queryKey: ["user-profile", "me"] as const,
    queryFn: () => userProfileApi.getMe(),
    retry: false,
  });

  const [prefs, setPrefs] = useState<UserPreferences>(() => loadPreferences());

  const updatePrefs = useCallback(
    (patch: Partial<UserPreferences>, label: string) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        savePreferences(next);
        return next;
      });
      pushToast({ tone: "success", title: `${label} saved` });
    },
    [pushToast],
  );

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>([prefs.timezone, ...COMMON_TIMEZONES]);
    return Array.from(set).sort();
  }, [prefs.timezone]);

  const user: UserProfileType | null = meQuery.data ?? null;

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-muted-foreground shrink-0">
          <UserCircle className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold">Profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your AgentDash identity and preferences.
          </p>
        </div>
      </header>

      <IdentitySection
        user={user}
        isLoading={meQuery.isLoading}
        error={meQuery.error}
      />

      <PreferencesSection
        prefs={prefs}
        timezoneOptions={timezoneOptions}
        onChangeTimezone={(tz) => updatePrefs({ timezone: tz }, "Timezone")}
        onToggleEmail={(value) =>
          updatePrefs({ emailNotifications: value }, "Email notifications")
        }
        onToggleInApp={(value) =>
          updatePrefs({ inAppNotifications: value }, "In-app notifications")
        }
      />

      <DangerZoneSection userEmail={user?.email ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function IdentitySection({
  user,
  isLoading,
  error,
}: {
  user: UserProfileType | null;
  isLoading: boolean;
  error: unknown;
}) {
  return (
    <section
      data-testid="profile-identity-section"
      className="rounded-lg border border-border bg-card p-6"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Identity
      </h2>
      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load profile"}
          </p>
        ) : !user ? (
          <p className="text-sm text-muted-foreground">
            No active session. Sign in to view your profile.
          </p>
        ) : (
          <dl className="grid gap-3 text-sm">
            <div className="flex items-start gap-2">
              <UserCircle className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Name
                </dt>
                <dd className="mt-0.5 font-medium" data-testid="profile-name">
                  {user.name ?? "—"}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Mail className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Email
                </dt>
                <dd className="mt-0.5 font-medium break-all" data-testid="profile-email">
                  {user.email ?? "—"}
                </dd>
              </div>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PreferencesSection({
  prefs,
  timezoneOptions,
  onChangeTimezone,
  onToggleEmail,
  onToggleInApp,
}: {
  prefs: UserPreferences;
  timezoneOptions: string[];
  onChangeTimezone: (tz: string) => void;
  onToggleEmail: (value: boolean) => void;
  onToggleInApp: (value: boolean) => void;
}) {
  return (
    <section
      data-testid="profile-preferences-section"
      className="rounded-lg border border-border bg-card p-6"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Preferences
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Preferences are stored locally in this browser.
      </p>

      <div className="mt-4 space-y-5">
        <div>
          <label
            htmlFor="profile-timezone-select"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <Globe className="h-4 w-4 text-muted-foreground" />
            Timezone
          </label>
          <select
            id="profile-timezone-select"
            data-testid="profile-timezone-select"
            value={prefs.timezone}
            onChange={(e) => onChangeTimezone(e.target.value)}
            className="mt-2 block w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Bell className="h-4 w-4 text-muted-foreground" />
            Notifications
          </p>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              data-testid="profile-email-notifications"
              checked={prefs.emailNotifications}
              onChange={(e) => onToggleEmail(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span className="min-w-0">
              <span className="font-medium">Email notifications</span>
              <span className="block text-xs text-muted-foreground">
                Receive summary emails for important agent activity.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              data-testid="profile-inapp-notifications"
              checked={prefs.inAppNotifications}
              onChange={(e) => onToggleInApp(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span className="min-w-0">
              <span className="font-medium">In-app notifications</span>
              <span className="block text-xs text-muted-foreground">
                Show toasts and badges inside AgentDash.
              </span>
            </span>
          </label>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerZoneSection({ userEmail }: { userEmail: string | null }) {
  return (
    <section
      data-testid="profile-danger-zone-section"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-6"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-destructive">
        <AlertTriangle className="h-4 w-4" />
        Danger zone
      </h2>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-destructive">Delete account</p>
          <p className="mt-1 text-muted-foreground">
            Self-service account deletion is not yet available. Contact an
            instance admin to remove
            {userEmail ? (
              <>
                {" "}
                <span className="font-medium text-foreground">{userEmail}</span>
              </>
            ) : (
              " your account"
            )}
            .
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled
          data-testid="profile-delete-account"
          title="Contact admin to delete account"
        >
          Delete account
        </Button>
      </div>
    </section>
  );
}
