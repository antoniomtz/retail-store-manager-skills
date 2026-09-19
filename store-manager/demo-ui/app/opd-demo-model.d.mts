export type OpdPlan = {
  planId: string;
  title: string;
  action: string;
  recommended: boolean;
  sourceDepartment: string | null;
  additionalAssociates: number;
  assignmentDurationMinutes: number;
  incrementalPickRate: number;
  projectionHorizonMinutes: number;
  projectedPickRate: number;
  projectedBacklog: number;
  meetsCheckpoint: boolean;
  tradeoffs: string[];
};

export type OpdDemoState = {
  connected: boolean;
  store: { id: string | null; name: string | null; businessDate: string | null };
  stateVersion: number;
  simulatedAt: string | null;
  operatingStatus: string;
  phase: "normal" | "hermes_analyzing" | "awaiting_approval" | "action_executed" | "progress_on_track" | "progress_off_track" | "recovered" | "follow_up" | "unavailable";
  operations: {
    itemsDue: number;
    ordersDue: number;
    backlog: number;
    backlogVisualUnits: number;
    currentPickers: number;
    currentPickRate: number;
    normalPickRate: number;
    recoveryMinimumPickRate: number;
    recoveryMaximumBacklog: number;
  };
  recoveryContext: {
    availableAssociates: number;
    sourceDepartment: string | null;
    assignmentDurationMinutes: number;
    checkpointAfterMinutes: number;
  };
  events: Array<{
    id: string | null;
    type: string;
    label: string | null;
    additionalItemsDue: number;
    additionalOrdersDue: number;
    additionalBacklog: number;
    pickerReduction: number;
    pickRateReduction: number;
  }>;
  decision: {
    id: string | null;
    status: string | null;
    author: string | null;
    method: string | null;
    managerMessageStatus: string | null;
    managerMessageReadyAt: string | null;
    candidateSetId: string | null;
    recommendationReason: string | null;
    tradeoffSummary: string | null;
    evaluatedCandidateCount: number;
    recommendedPlanId: string | null;
    basedOnStateVersion: number;
    plans: OpdPlan[];
  } | null;
  receipt: {
    id: string | null;
    status: string | null;
    planId: string | null;
    externalSystem: string | null;
    associatesAssigned: number;
    incrementalPickRate: number;
    assignmentDurationMinutes: number;
    assignmentStatus: string;
  } | null;
  checkpoint: {
    id: string | null;
    stage: string;
    status: string | null;
    dueAt: string | null;
    targetMet: boolean | null;
    afterMinutes: number;
    elapsedAssignmentMinutes: number;
    nextMeasurementAfterMinutes: number;
    assignmentDurationMinutes: number;
    measuredPickRate: number;
    measuredBacklog: number;
    minimumPickRate: number;
    maximumBacklog: number;
    guidance: string | null;
  } | null;
  capabilities: { simulatedApproval: boolean };
};

export const OPD_ARTWORK_PICKERS: number;
export function opdPickerVisualCounts(currentPickers: number, assignedAssociates?: number): {
  reported: number;
  artwork: number;
  supplemental: number;
  assigned: number;
  represented: number;
};
export function projectOpdState(raw: unknown, options?: { simulatedApproval?: boolean }): OpdDemoState;
export function unavailableOpdState(): OpdDemoState;
