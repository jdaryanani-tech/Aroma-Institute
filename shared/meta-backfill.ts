export type MetaBackfillForm = {
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
  leadsCount: number | null;
};

export type MetaBackfillWindow = {
  timezone: "Asia/Kolkata";
  startDate: string;
  endDate: string;
  startUtc: string;
  endUtcExclusive: string;
  maximumDays: number;
};

export type MetaBackfillFormCounts = {
  formId: string;
  name: string;
  status: string;
  fetched: number;
  alreadyPresent: number;
  eligibleNew: number;
  validPhone: number;
  phoneReview: number;
  imported: number;
  importReview: number;
  failed: number;
};

export type MetaBackfillTotals = Omit<MetaBackfillFormCounts, "formId" | "name" | "status">;

export type MetaBackfillProgress = {
  phase: "preview" | "import";
  state: "running" | "complete";
  continuationToken: string;
  expiresAt: string;
  window: MetaBackfillWindow;
  batchSize: number;
  identityResolution: "determined_during_import";
  approvedImportCount: number | null;
  forms: MetaBackfillFormCounts[];
  totals: MetaBackfillTotals;
};

export type MetaBackfillSafeError = {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  graph?: {
    httpStatus: number;
    errorType?: string;
    errorCode?: number;
    errorSubcode?: number;
    isTransient?: boolean;
  };
  continuationToken?: string;
  expiresAt?: string;
  progress?: MetaBackfillProgress;
};
