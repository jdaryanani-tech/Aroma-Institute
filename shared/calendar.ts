export const CALENDAR_CATEGORIES = [
  "admissions",
  "academic",
  "workshops",
  "staff",
  "operations",
  "student",
] as const;
export type CalendarCategory = (typeof CALENDAR_CATEGORIES)[number];
export type CalendarEventStatus =
  | "draft"
  | "requested"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "rescheduled";
export type CalendarView = "day" | "week" | "month" | "agenda" | "my" | "resource";

export type CalendarEvent = {
  id: string;
  source: "calendar" | "lms_session" | "crm_follow_up" | "counselling_request";
  title: string;
  description: string | null;
  category: CalendarCategory;
  eventType: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  allDay: boolean;
  location: string | null;
  onlineUrl: string | null;
  status: CalendarEventStatus;
  organizerId: number | null;
  ownerId: number | null;
  attendeeIds: number[];
  leadId: string | null;
  inquiryId: number | null;
  studentId: number | null;
  courseId: number | null;
  batchId: number | null;
  trainerId: number | null;
  resourceId: number | null;
  capacity: number | null;
  recurrence: { frequency: "daily" | "weekly" | "monthly"; interval: number; until: string | null; weekdays?: number[] } | null;
  version: number;
  conflictWarnings: string[];
};

export type CalendarEventInput = {
  title: string;
  description?: string | null;
  category: CalendarCategory;
  eventType: string;
  startsAt: string;
  endsAt?: string | null;
  timezone?: string;
  allDay?: boolean;
  location?: string | null;
  onlineUrl?: string | null;
  status?: CalendarEventStatus;
  ownerId?: number | null;
  attendeeIds?: number[];
  leadId?: string | null;
  inquiryId?: number | null;
  studentId?: number | null;
  courseId?: number | null;
  batchId?: number | null;
  trainerId?: number | null;
  resourceId?: number | null;
  capacity?: number | null;
  recurrence?: CalendarEvent["recurrence"];
  overrideReason?: string;
};

export type CalendarFilters = {
  start: string;
  end: string;
  category?: CalendarCategory;
  courseId?: number;
  batchId?: number;
  staffId?: number;
  resourceId?: number;
  status?: CalendarEventStatus;
  search?: string;
  location?: string;
  view?: CalendarView;
};

export type CalendarResource = {
  id: number;
  name: string;
  kind: "classroom" | "lab" | "equipment" | "location" | "other";
  location: string | null;
  capacity: number | null;
  active: boolean;
};

export type CalendarInboxItem = {
  id: number;
  title: string;
  body: string;
  category: string;
  priority: "normal" | "high" | "urgent";
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export type CalendarPreferences = {
  pushEnabled: boolean;
  inAppEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  reminderOffsetsMinutes: number[];
};
