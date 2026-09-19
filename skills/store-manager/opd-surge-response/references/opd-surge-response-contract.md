# Store Manager OPD surge-response contract

The packaged helper and managed Hermes response-ready hook are the only
supported clients for these private synthetic Camel paths:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/store-opd-operating-state` | Observe the current simulation, pending decision, receipt, and checkpoint. |
| `POST` | `/v1/store-opd-recovery-plans` | Create or retrieve safe, unranked recovery candidates. |
| `POST` | `/v1/store-opd-decisions` | Validate and persist Hermes's recommendation, alternate, reason, and tradeoff. |
| `POST` | `/v1/store-opd-manager-message` | Let the managed `agent:end` hook publish choices after the final manager response exists. |
| `POST` | `/v1/store-opd-actions` | Approve or reject one decision, or acknowledge a reported checkpoint. |

Every request is scoped to the installed `store_id` and synthetic
`business_date`. An approval also carries the decision's
`based_on_state_version`; Camel rejects it if a later event made the decision
stale. Mutation requests carry an idempotency key.

`metrics.target_pick_rate_items_per_hour` is the normal operating pace.
`recovery_context.minimum_pick_rate_items_per_hour` and
`maximum_remaining_pick_queue_items` are the separate recovery conditions
first measured after `checkpoint_after_minutes`. That early progress check
does not end the returned assignment. The same conditions are measured again
at `assignment_duration_minutes` for the final outcome. Present these timings
with distinct labels; neither value replaces the normal operating pace.

## Monitor actions

`operating_state.monitor.action` controls event-monitor behavior:

| Value | Treatment |
| --- | --- |
| `none` | No alert. |
| `request_recovery_plan` | Ask the simulator for safe recovery candidates. |
| `await_agent_recommendation` | Retrieve the current candidates and let Hermes rank and commit them. |
| `await_manager_decision` | A decision was already presented; do not repeat it. |
| `manager_rejected` | The manager rejected the current decision; do not recreate it without a new event. |
| `monitor_checkpoint` | An approved action is still inside its measurement window; do not claim success. |
| `report_checkpoint` | Report the measured result and acknowledge it so later event runs do not repeat it. |

## Decision and action rules

- Candidate staffing counts and projections are deterministic simulator
  results. Hermes ranks only those candidates and persists its reason and
  tradeoff; it cannot invent staffing math.
- Camel accepts plan IDs only from the current candidate set and only while its
  state version remains current.
- Every feasible plan includes an authoritative title, action, staffing count,
  assignment duration, projection horizon, projected rate and queue, and
  operational impact. Alert and review messages copy those same values.
- Only a manager's explicit approval of a returned `decision_id` authorizes a
  call to the action API.
- An approved response is verified only when `action_receipt.status` is
  `accepted` and the next operating-state read returns the same receipt ID.
- Rejection does not execute an external action.
- A checkpoint is observed evidence. Its `met` or `missed` status must be
  reported with the returned measured and target fields. A `progress`
  checkpoint says whether recovery is on track while the assignment remains
  active. Only a `final` checkpoint can confirm completed recovery and release
  the temporary associates.

For presentation consistency, `commit` and `review` include the exact
`recommended_plan` selected by Hermes and persisted in the current decision. A verified approval
includes the exact `selected_plan` and scheduled `checkpoint`; templates do
not reconstruct either from conversation history.

## Manager action buttons

For a committed or reviewed decision with exactly two feasible plans, the helper
returns a deterministic `manager_choices` list:

1. Approve the returned recommended plan.
2. Approve the other returned feasible plan.
3. Reject the decision without executing an external action.

The webhook session can alert through Telegram but cannot host Telegram action
buttons. The manager starts a Telegram agent turn by asking to review the OPD
decision. The agent runs the read-only `review` command, passes the returned
choice labels to Hermes's `clarify` tool, and waits for an authorized Telegram
button callback. Only an exact returned label is mapped back to its choice
number. The subsequent `choose` command requires the reviewed `decision_id`,
rebuilds the mapping from fresh operating state, and rejects a stale, resolved,
or replaced decision before calling the action API. Typed numbers and free-text
`Other` responses are not authorization.

## Errors

`400` indicates invalid input, `404` an unknown store/date/decision/checkpoint,
and `409` a state conflict such as no required intervention, a resolved or
stale decision, or a checkpoint that is not ready. Stop and report the error;
do not change identifiers or retry against another path.
