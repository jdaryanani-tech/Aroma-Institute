import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarFilters,
  CalendarInboxItem,
  CalendarPreferences,
  CalendarResource,
} from "@shared/calendar";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Calendar request failed (${response.status})`);
  }
  return response.json();
}

export function useCalendarEvents(filters: CalendarFilters, enabled = true) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
  return useQuery<CalendarEvent[]>({
    queryKey: ["aichm-calendar", "events", filters],
    queryFn: () => request(`/api/calendar/events?${query}`),
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

export function useCreateCalendarEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CalendarEventInput) => request<CalendarEvent>("/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar"] }),
  });
}

export function useUpdateCalendarEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedVersion, update }: { id: string; expectedVersion: number; update: Partial<CalendarEventInput> }) =>
      request<CalendarEvent>(`/api/calendar/events/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion, update }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar"] }),
  });
}

export function useCalendarResources(enabled = true) {
  return useQuery<CalendarResource[]>({
    queryKey: ["aichm-calendar", "resources"],
    queryFn: () => request("/api/calendar/resources"),
    enabled,
    retry: false,
  });
}

export function useCalendarInbox(enabled = true) {
  return useQuery<{ items: CalendarInboxItem[]; unreadCount: number }>({
    queryKey: ["aichm-calendar", "inbox"],
    queryFn: () => request("/api/calendar/inbox"),
    enabled,
    retry: false,
    refetchInterval: 60_000,
  });
}

export function useMarkCalendarNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request(`/api/calendar/inbox/${id}/read`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar", "inbox"] }),
  });
}

export function useMarkAllCalendarNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request("/api/calendar/inbox/read-all", { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar", "inbox"] }),
  });
}

export function useCalendarPreferences(enabled = true) {
  return useQuery<CalendarPreferences>({
    queryKey: ["aichm-calendar", "preferences"],
    queryFn: () => request("/api/calendar/preferences"),
    enabled,
    retry: false,
  });
}

export function useUpdateCalendarPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (preferences: Partial<CalendarPreferences>) => request<CalendarPreferences>("/api/calendar/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preferences),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar", "preferences"] }),
  });
}

export function usePushPublicKey(enabled = true) {
  return useQuery<{ publicKey: string | null }>({
    queryKey: ["aichm-calendar", "push-public-key"],
    queryFn: () => request("/api/calendar/push/public-key"),
    enabled,
    retry: false,
    staleTime: 60 * 60_000,
  });
}

export function useSubscribePush() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { subscription: PushSubscriptionJSON; deviceLabel: string; appScope: "admin" | "learn" }) =>
      request("/api/calendar/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar", "preferences"] }),
  });
}

export function useUnsubscribePush() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (endpoint: string) => request("/api/calendar/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["aichm-calendar", "preferences"] }),
  });
}
