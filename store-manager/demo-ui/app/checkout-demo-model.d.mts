export type CheckoutPlan = {
  planId: string;
  title: string;
  action: string;
  recommended: boolean;
  registersToOpen: number;
  selfCheckoutHostsToReposition: number;
  associatesReassigned: number;
  assignmentDurationMinutes: number;
  projectedPeopleInQueue: number;
  projectedWaitMinutes: number;
  tradeoffs: string[];
};

export type CheckoutDemoState = {
  connected: boolean;
  store: { id: string | null; name: string | null; businessDate: string | null; zone: string | null };
  stateVersion: number;
  simulatedAt: string | null;
  operatingStatus: string;
  phase: "normal" | "hermes_analyzing" | "awaiting_approval" | "action_executed" | "recovered" | "follow_up" | "unavailable";
  queue: {
    people: number;
    visiblePeople: number;
    waitMinutes: number;
    maximumPeople: number;
    maximumWaitMinutes: number;
    activeStaffedLanes: number;
    baselineStaffedLanes: number;
    visionConfidence: number;
  };
  event: { id: string | null; type: string | null; label: string | null } | null;
  decision: {
    id: string | null;
    status: string | null;
    author: string | null;
    method: string | null;
    candidateSetId: string | null;
    recommendationReason: string | null;
    tradeoffSummary: string | null;
    evaluatedCandidateCount: number;
    recommendedPlanId: string | null;
    basedOnStateVersion: number;
    plans: CheckoutPlan[];
  } | null;
  receipt: {
    id: string | null;
    status: string | null;
    planId: string | null;
    externalSystem: string | null;
    staffedRegistersOpened: number;
    selfCheckoutHostsRepositioned: number;
    associatesReassigned: number;
    assignmentDurationMinutes: number;
  } | null;
  checkpoint: {
    id: string | null;
    status: string | null;
    dueAt: string | null;
    targetMet: boolean | null;
    afterMinutes: number;
  } | null;
  capabilities: { simulatedApproval: boolean };
};

export function projectCheckoutState(raw: unknown, options?: { simulatedApproval?: boolean; baselineStaffedLanes?: number }): CheckoutDemoState;
export function unavailableCheckoutState(): CheckoutDemoState;
