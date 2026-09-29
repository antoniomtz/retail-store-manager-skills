import assert from "node:assert/strict";
import test from "node:test";

import {
  projectMorningBriefingPresentation,
  unavailableMorningBriefingPresentation,
} from "../app/morning-briefing-model.mjs";


const identity = { store_id: "SEA-014", business_date: "2026-08-03" };

function readyPresentation() {
  return {
    contract_version: "0.1.0",
    ...identity,
    status: "ready",
    cleared: false,
    presentation: {
      presentation_id: "MBR-123",
      ...identity,
      published_at: "2026-08-03T13:00:00Z",
      priorities: [
        { rank: 1, title: "Verify the opening safety observations", evidence: "Two observations still require confirmation." },
        { rank: 2, title: "Cover the morning fulfillment shortage", evidence: "Two associates are scheduled where three are needed." },
        { rank: 3, title: "Review the first online-order promises", evidence: "The first pick started 15 minutes late." },
      ],
    },
  };
}

function openingSnapshot() {
  return {
    contract_version: "0.3.0",
    ...identity,
    opening_leadership: [
      {
        leader_reference: "SYNTH-COACH-01",
        display_name: "Elena Martinez",
        role: "Opening Coach",
        departments: ["Storewide"],
        shift: "06:00-15:00",
        status: "on_site",
      },
      {
        leader_reference: "SYNTH-TL-01",
        display_name: "Priya Shah",
        role: "Front End Team Lead",
        departments: ["Checkout"],
        shift: "07:00-16:00",
        status: "scheduled",
      },
    ],
    store_condition: {
      overall_status: "attention_needed",
      areas_ready: 1,
      areas_checked: 2,
      checks: [
        { area: "Customer entrance and carts", status: "ready" },
        { area: "Salesfloor signing", status: "attention_needed" },
      ],
      major_issues: [
        {
          issue_id: "OPEN-ISSUE-001",
          area: "Outdoor promotional display",
          severity: "medium",
          status: "open",
          description: "The patio display is missing promotional price signs.",
          owner_role: "Salesfloor Team Lead",
          target_resolution_at: "2026-08-03T09:00:00-07:00",
        },
      ],
    },
    staffing_gaps: [
      {
        department: "Fulfillment",
        time_window: "09:00-12:00",
        scheduled_headcount: 2,
        required_headcount: 3,
        coverage_gap: 1,
      },
    ],
  };
}

test("projects bounded morning priority cards", () => {
  const result = projectMorningBriefingPresentation(readyPresentation(), identity, openingSnapshot());
  assert.equal(result.connected, true);
  assert.equal(result.status, "ready");
  assert.equal(result.presentation?.id, "MBR-123");
  assert.deepEqual(result.presentation?.priorities.map((priority) => priority.rank), [1, 2, 3]);
  assert.equal(result.presentation?.openingTeam[0].displayName, "Elena Martinez");
  assert.equal(result.presentation?.readiness.areasReady, 1);
  assert.equal("checks" in result.presentation.readiness, false);
  assert.equal(result.presentation?.readiness.issues.length, 1);
  assert.equal(result.presentation?.readiness.staffingGaps[0].shortage, 1);
});
test("projects an intentionally empty presentation after reset", () => {
  const result = projectMorningBriefingPresentation({
    contract_version: "0.1.0",
    ...identity,
    status: "empty",
    presentation: null,
    cleared: true,
  }, identity);
  assert.equal(result.connected, true);
  assert.equal(result.status, "empty");
  assert.equal(result.presentation, null);
});

test("rejects mismatched identity and malformed priority order", () => {
  assert.throws(
    () => projectMorningBriefingPresentation(readyPresentation(), { ...identity, store_id: "OTHER" }),
    /identity mismatch/,
  );
  const malformed = readyPresentation();
  malformed.presentation.priorities[0].rank = 2;
  assert.throws(() => projectMorningBriefingPresentation(malformed, identity, openingSnapshot()), /invalid morning priority/);
});

test("rejects mismatched or inconsistent opening context", () => {
  assert.throws(
    () => projectMorningBriefingPresentation(readyPresentation(), identity, { ...openingSnapshot(), store_id: "OTHER" }),
    /snapshot identity mismatch/,
  );
  const malformed = openingSnapshot();
  malformed.store_condition.areas_checked = 3;
  assert.throws(
    () => projectMorningBriefingPresentation(readyPresentation(), identity, malformed),
    /area count mismatch/,
  );
});

test("uses an explicit unavailable state", () => {
  assert.deepEqual(unavailableMorningBriefingPresentation(), {
    connected: false,
    status: "unavailable",
    storeId: null,
    businessDate: null,
    presentation: null,
  });
});
