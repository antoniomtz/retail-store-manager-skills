function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value, maximumLength, label) {
  const result = text(value);
  if (!result || result.length > maximumLength) throw new Error(`invalid ${label}`);
  return result;
}

function boundedArray(value, maximumLength, label) {
  if (!Array.isArray(value) || value.length > maximumLength) throw new Error(`invalid ${label}`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function projectOpeningContext(snapshot, storeId, businessDate) {
  const source = record(snapshot);
  if (source.store_id !== storeId || source.business_date !== businessDate) {
    throw new Error("morning snapshot identity mismatch");
  }

  const openingTeam = boundedArray(source.opening_leadership, 12, "opening leadership").map((value) => {
    const leader = record(value);
    const status = leader.status;
    if (!new Set(["on_site", "scheduled"]).has(status)) throw new Error("invalid leader status");
    const departments = boundedArray(leader.departments, 8, "leader departments")
      .map((department) => boundedText(department, 64, "leader department"));
    if (!departments.length) throw new Error("invalid leader departments");
    return {
      reference: boundedText(leader.leader_reference, 64, "leader reference"),
      displayName: boundedText(leader.display_name, 100, "leader name"),
      role: boundedText(leader.role, 100, "leader role"),
      departments,
      shift: boundedText(leader.shift, 32, "leader shift"),
      status,
    };
  });
  if (!openingTeam.length) throw new Error("invalid opening leadership");

  const condition = record(source.store_condition);
  const overallStatus = condition.overall_status;
  if (!new Set(["ready", "attention_needed"]).has(overallStatus)) {
    throw new Error("invalid readiness status");
  }
  const areasReady = nonNegativeInteger(condition.areas_ready, "ready area count");
  const areasChecked = nonNegativeInteger(condition.areas_checked, "checked area count");
  if (!areasChecked || areasReady > areasChecked) throw new Error("invalid readiness counts");

  const checks = boundedArray(condition.checks, 20, "readiness checks").map((value) => {
    const check = record(value);
    const status = check.status;
    if (!new Set(["ready", "attention_needed"]).has(status)) throw new Error("invalid area status");
    return { area: boundedText(check.area, 120, "readiness area"), status };
  });
  if (checks.length !== areasChecked) throw new Error("readiness area count mismatch");

  const issues = boundedArray(condition.major_issues, 10, "readiness issues")
    .filter((value) => record(value).status === "open")
    .map((value) => {
      const issue = record(value);
      const severity = issue.severity;
      if (!new Set(["critical", "high", "medium", "low"]).has(severity)) {
        throw new Error("invalid issue severity");
      }
      const targetResolutionAt = boundedText(issue.target_resolution_at, 64, "issue target");
      if (!Number.isFinite(Date.parse(targetResolutionAt))) throw new Error("invalid issue target");
      return {
        id: boundedText(issue.issue_id, 64, "issue id"),
        area: boundedText(issue.area, 120, "issue area"),
        severity,
        description: boundedText(issue.description, 280, "issue description"),
        ownerRole: boundedText(issue.owner_role, 100, "issue owner"),
        targetResolutionAt,
      };
    });

  const staffingGaps = boundedArray(source.staffing_gaps, 12, "staffing gaps").map((value) => {
    const gap = record(value);
    const scheduledHeadcount = nonNegativeInteger(gap.scheduled_headcount, "scheduled headcount");
    const requiredHeadcount = nonNegativeInteger(gap.required_headcount, "required headcount");
    const shortage = nonNegativeInteger(gap.coverage_gap, "staffing shortage");
    if (requiredHeadcount <= scheduledHeadcount || shortage !== requiredHeadcount - scheduledHeadcount) {
      throw new Error("invalid staffing gap");
    }
    return {
      department: boundedText(gap.department, 64, "staffing department"),
      timeWindow: boundedText(gap.time_window, 32, "staffing window"),
      scheduledHeadcount,
      requiredHeadcount,
      shortage,
    };
  });

  return {
    openingTeam,
    readiness: { overallStatus, areasReady, areasChecked, issues, staffingGaps },
  };
}

export function projectMorningBriefingPresentation(raw, expectedIdentity, snapshot) {
  const source = record(raw);
  const storeId = text(source.store_id);
  const businessDate = text(source.business_date);
  if (storeId !== expectedIdentity.store_id || businessDate !== expectedIdentity.business_date) {
    throw new Error("morning presentation identity mismatch");
  }

  if (source.status === "empty" && source.presentation === null) {
    return { connected: true, status: "empty", storeId, businessDate, presentation: null };
  }
  if (source.status !== "ready") throw new Error("invalid morning presentation status");

  const presentation = record(source.presentation);
  const presentationId = text(presentation.presentation_id);
  const publishedAt = text(presentation.published_at);
  const priorities = Array.isArray(presentation.priorities) ? presentation.priorities : [];
  if (
    !presentationId
    || !publishedAt
    || !Number.isFinite(Date.parse(publishedAt))
    || presentation.store_id !== storeId
    || presentation.business_date !== businessDate
    || priorities.length < 1
    || priorities.length > 4
  ) {
    throw new Error("invalid morning presentation");
  }

  const projectedPriorities = priorities.map((value, index) => {
    const priority = record(value);
    const title = text(priority.title);
    const evidence = text(priority.evidence);
    if (
      priority.rank !== index + 1
      || !title
      || title.length > 140
      || !evidence
      || evidence.length > 280
    ) {
      throw new Error("invalid morning priority");
    }
    return { rank: index + 1, title, evidence };
  });

  const opening = projectOpeningContext(snapshot, storeId, businessDate);

  return {
    connected: true,
    status: "ready",
    storeId,
    businessDate,
    presentation: {
      id: presentationId,
      publishedAt,
      priorities: projectedPriorities,
      ...opening,
    },
  };
}

export function unavailableMorningBriefingPresentation() {
  return {
    connected: false,
    status: "unavailable",
    storeId: null,
    businessDate: null,
    presentation: null,
  };
}
