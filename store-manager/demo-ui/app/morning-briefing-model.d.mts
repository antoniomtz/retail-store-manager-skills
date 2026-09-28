export type MorningPriority = {
  rank: number;
  title: string;
  evidence: string;
};
export type OpeningLeader = {
  reference: string;
  displayName: string;
  role: string;
  departments: string[];
  shift: string;
  status: "on_site" | "scheduled";
};

export type ReadinessIssue = {
  id: string;
  area: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  ownerRole: string;
  targetResolutionAt: string;
};

export type StaffingGap = {
  department: string;
  timeWindow: string;
  scheduledHeadcount: number;
  requiredHeadcount: number;
  shortage: number;
};

export type OpeningReadiness = {
  overallStatus: "ready" | "attention_needed";
  areasReady: number;
  areasChecked: number;
  issues: ReadinessIssue[];
  staffingGaps: StaffingGap[];
};

export type MorningBriefingPresentation = {
  connected: boolean;
  status: "ready" | "empty" | "unavailable";
  storeId: string | null;
  businessDate: string | null;
  presentation: {
    id: string;
    publishedAt: string;
    priorities: MorningPriority[];
    openingTeam: OpeningLeader[];
    readiness: OpeningReadiness;
  } | null;
};

export function projectMorningBriefingPresentation(
  raw: unknown,
  expectedIdentity: { store_id: string; business_date: string },
  snapshot?: unknown,
): MorningBriefingPresentation;

export function unavailableMorningBriefingPresentation(): MorningBriefingPresentation;
