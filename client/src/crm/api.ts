import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CrmAssignmentUpdate, CrmDetail, CrmFilters, CrmList, CrmUpdate } from "@shared/crm";

export class CrmHttpError extends Error {
  constructor(public status:number,message:string) {super(message);}
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new CrmHttpError(response.status,body.message || `CRM request failed (${response.status})`);
  }
  return response.json();
}
export function useCrmLeads(filters: CrmFilters, enabled: boolean, scopeKey: string) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
  return useQuery<CrmList>({
    queryKey: ["admin-crm", scopeKey, "leads", filters], queryFn: () => request(`/api/admin/crm/leads?${query}`),
    enabled, retry: false, staleTime: 0,
  });
}
export function useCrmDetail(id: string | null, enabled: boolean, scopeKey: string) {
  return useQuery<CrmDetail>({
    queryKey: ["admin-crm", scopeKey, "detail", id],
    queryFn: () => request(`/api/admin/crm/leads/${encodeURIComponent(id!)}`),
    enabled: enabled && Boolean(id), retry: false, staleTime: 0,
  });
}
export type CrmConversationPage = {
  state: "available" | "not_configured" | "unavailable" | "unlinked";
  items: NonNullable<CrmDetail["conversationHistory"]>["items"];
  nextCursor: string | null;
};
export function fetchCrmConversationPage(id: string, cursor: string, limit = 50) {
  const query = new URLSearchParams({ cursor, limit: String(limit) });
  return request<CrmConversationPage>(
    `/api/admin/crm/leads/${encodeURIComponent(id)}/conversations?${query}`,
  );
}
export function useCrmUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: CrmUpdate }) =>
      request<CrmDetail>(`/api/admin/crm/leads/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin-crm"] }),
  });
}
export function useCrmAssignment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ leadId, update }: { leadId: string; update: CrmAssignmentUpdate }) =>
      request(`/api/admin/crm/leads/${encodeURIComponent(leadId)}/assignment`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin-crm"] }),
  });
}
export function useCrmRetry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (inquiryId: number) => request(`/api/admin/inquiries/${inquiryId}/retry-counselling-delivery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifiedNotDelivered: true }),
    }),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin-crm"] }),
  });
}
