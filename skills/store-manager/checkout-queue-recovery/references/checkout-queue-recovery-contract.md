# Checkout queue recovery contract

The packaged helper is the only supported client for these private synthetic
Camel paths:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/store-checkout-operating-state` | Read current aggregate queue state, forecast, constraints, decision, receipt, and checkpoint. |
| `POST` | `/v1/store-checkout-recovery-plans` | Return a current safe candidate set, or replace it after confirmed manager constraints. |
| `POST` | `/v1/store-checkout-decisions` | Validate and persist Hermes's ranked recommendation, alternate, reason, and tradeoff. |
| `POST` | `/v1/store-checkout-actions` | Approve or reject one current decision, or acknowledge a measured checkpoint. |

Every request is scoped to the installed store and synthetic business date.
The external vision event contains no image and is only a wake-up signal.
Current facts always come from the operating-state read.

## State machine

`monitor.action` controls event behavior:

| Value | Treatment |
| --- | --- |
| `none` | Do not alert. |
| `request_recovery_plan` | Ask Camel for fresh safe candidates. Do not alert yet. |
| `await_agent_recommendation` | Re-read the current candidate set and finish the interrupted agent decision. |
| `await_manager_decision` | Do not repeat the pending proposal. |
| `manager_rejected` | Do not recreate the rejected proposal without a new event. |
| `monitor_checkpoint` | Do not claim success before measurement. |
| `report_checkpoint` | Report and acknowledge the measured result exactly once. |

Camel supplies every safe candidate, its projected queue and wait, and blocked
options. It does not choose or rank them. Hard workforce, break, training, and
minimum-coverage constraints are never adjustable. Hermes evaluates the
bounded candidates, selects one recommendation and one useful alternate when
available, writes a reason and tradeoff, and commits that structured decision.
Camel accepts only exact IDs from the current candidate set and records
`decision_author: hermes`. The manager can only add temporary constraints
allowed by `instruction_schema`.

Every plan supplies one authoritative `associates_reassigned` count, equal to
the number of entries in `associate_references`. It counts everyone whose work
assignment changes, including an associate who moves from the front-end
service desk to self-checkout. Alert and review messages must copy the same
`title`, `action`, staffing count, duration, projections, and tradeoffs. The
forecast's `reason` explains the business situation in plain language and its
`evidence` explains why the elevated demand may continue. Each feasible plan's
`projection_horizon_minutes` supplies the follow-up horizon; presentation
templates never assume a fixed interval.

`monitor` and `replan` return `agent_recommendation_required` with no manager
decision. Only `commit` returns `manager_decision_required` and the current
`recommended_plan` selected by Hermes. `review` reads that persisted decision.
A verified approval includes the exact `selected_plan` and scheduled
`checkpoint`; templates do not reconstruct either from conversation history.

## Buttons and natural-language adjustment

`review` returns no more than four decision-scoped choices: one or two feasible
plans, followed by `Adjust plan with instructions` and `Reject this decision`. Hermes's Telegram
`clarify` callback supplies the exact selected label. A typed number or the
automatic free-text `Other` response is not authorization.

The adjust choice performs no external action. Hermes asks for one instruction,
maps only supported content into bounded flags, and obtains a separate
confirmation before calling `replan`. Camel validates those constraints and
invalidates the old approval while Hermes judges the replacement candidate
set. A subsequent `commit` creates the new decision ID. Buttons from the
superseded decision cannot execute. The updated decision requires a new review
and approval turn.

Checkout event, decision, receipt, and checkpoint IDs include a per-simulation
run namespace. Resetting or recreating Camel therefore invalidates buttons and
identifiers from an earlier run instead of reusing them.

## Action integrity

Approval includes the exact current decision ID, its state version, a feasible
plan ID, and an idempotency key. Camel returns a simulated external-system
receipt. The helper verifies the same receipt on a fresh state read before
reporting execution. Rejection never calls a staffing or lane action.

A checkpoint is observed evidence, not a predicted success. Report its
measured and target queue and wait fields. Trace presence is not proof that an
action occurred; the receipt remains authoritative.

## Errors

`400` means invalid input, `404` an unknown store, date, candidate set,
decision, plan, or checkpoint, and `409` a state conflict such as a stale
candidate set or a superseded or resolved decision. Stop and report the error
without changing identifiers or retrying a different path.
