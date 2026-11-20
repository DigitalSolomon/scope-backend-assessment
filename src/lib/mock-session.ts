"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "~/lib/api";
import type { ApiUser } from "~/types/assessment";

const STORAGE_KEY = "scope-assessment-user-id";
const DEFAULT_USER_ID = "user-admin-avery";

const readStored = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * Mock session: no login, the acting user is picked from a list loaded from
 * the database. The chosen id is sent to the API as x-user-id.
 */
export function useMockSession() {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ users: ApiUser[] }>("/api/users")
      .then(({ users }) => {
        if (cancelled) return;
        setUsers(users);
        const stored = readStored();
        const initial =
          users.find((u) => u.id === stored)?.id ??
          users.find((u) => u.id === DEFAULT_USER_ID)?.id ??
          users[0]?.id ??
          null;
        setUserId(initial);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      if (userId) window.localStorage.setItem(STORAGE_KEY, userId);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable; selection just won't persist
    }
  }, [userId]);

  const user = useMemo(() => users.find((u) => u.id === userId) ?? null, [users, userId]);

  return {
    users,
    user,
    userId,
    setUserId,
    signOut: () => setUserId(null),
    loading: users.length === 0 && !error,
    error,
  };
}
