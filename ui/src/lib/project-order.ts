import type { Project } from "@paperclipai/shared";

export const PROJECT_ORDER_UPDATED_EVENT = "agentdash:project-order-updated";
const PROJECT_ORDER_STORAGE_PREFIX = "agentdash.projectOrder";
const LEGACY_PROJECT_ORDER_STORAGE_PREFIX = "paperclip.projectOrder";
const ANONYMOUS_USER_ID = "anonymous";

// One-time migration of legacy paperclip.projectOrder:<companyId>:<userId> keys.
if (typeof window !== "undefined") {
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${LEGACY_PROJECT_ORDER_STORAGE_PREFIX}:`)) {
        legacyKeys.push(key);
      }
    }
    for (const legacyKey of legacyKeys) {
      const newKey = `${PROJECT_ORDER_STORAGE_PREFIX}${legacyKey.slice(LEGACY_PROJECT_ORDER_STORAGE_PREFIX.length)}`;
      if (!localStorage.getItem(newKey)) {
        const value = localStorage.getItem(legacyKey);
        if (value !== null) localStorage.setItem(newKey, value);
      }
      localStorage.removeItem(legacyKey);
    }
  } catch {
    // best-effort
  }
}

type ProjectOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getProjectOrderStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${PROJECT_ORDER_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function readProjectOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeProjectOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProjectOrderUpdatedDetail>(PROJECT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function sortProjectsByStoredOrder(projects: Project[], orderedIds: string[]): Project[] {
  if (projects.length === 0) return [];
  if (orderedIds.length === 0) return projects;

  const byId = new Map(projects.map((project) => [project.id, project]));
  const sorted: Project[] = [];

  for (const id of orderedIds) {
    const project = byId.get(id);
    if (!project) continue;
    sorted.push(project);
    byId.delete(id);
  }
  for (const project of byId.values()) {
    sorted.push(project);
  }
  return sorted;
}
