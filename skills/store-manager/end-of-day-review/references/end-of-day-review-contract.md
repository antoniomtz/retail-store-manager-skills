# Store Manager end-of-day review contract

The packaged helper is the only supported client for the private read-only
Camel path:

```text
GET /v1/store-end-of-day-review?store_id=<store>&business_date=<date>
```

The endpoint exposes an independent synthetic eight-hour store day. It does
not read the OPD or checkout operating-demo state and does not create a
webhook, scheduled task, staffing action, inventory action, or store task.

The repository-host simulator owns the separate mutation path
`POST /v1/demo/store-day`. That path accepts only `reset` and `run`, is not in
the Hermes skill configuration, and must never be called or exposed by this skill.

## Simulation states

| `simulation_status` | Treatment |
| --- | --- |
| `not_run` | Report that no completed day is available and provide the returned host-side simulator instruction. |
| `completed` | Verify the complete eight-hour period and produce the review. |

A completed result has exactly 480 simulated minutes, the expected number of
15-minute samples, no missing samples, and all required operating sections.
Do not present a partial day as an end-of-day result.

## Evidence sections

| Section | Meaning |
| --- | --- |
| `sales` | Observed transactions, net sales, plan, variance, average basket, and hourly results. |
| `checkout` | Observed wait and queue measurements plus authoritative incident and response timestamps. |
| `opd` | Observed pick-rate, backlog, at-risk-order, incident, recovery, and close results. |
| `workforce` | Synthetic role-level call-outs and measured fulfillment undercoverage. |
| `inventory` | Stockout duration, on-hand result, and unserved customer requests. |
| `incident_summary` | Store-wide operating-incident and supporting workforce-event counts without hiding the per-domain counts. |
| `observed_service_impact` | Direct counts from the simulation. These are not all financial losses. |
| `agent_assisted_impact` | Synthetic recommendation, manager approval, external-system receipts, measured checkpoints, alternative-offer records linked to simulated POS receipts, and bounded no-action estimates for three historical interventions. |
| `estimated_opportunity_cost` | A bounded range calculated by Camel from explicit fixture assumptions. |
| `tomorrow_context` | Synthetic weather, promotion, inbound inventory, opening workforce, and sales plan. |
| `timeline` | Thirty-two 15-minute evidence samples. Use only to verify patterns already summarized by the bounded sections. |

## Interpretation boundaries

- `agent_assisted_impact.provenance` is explicit: Hermes recommended, the Store
  Manager approved, and the simulated external system executed. Do not imply
  autonomous action by Hermes. Keep this technical provenance out of the
  completed manager-facing review; present only the operating action and its
  supported result.
- Treat `measured` values as synthetic observed receipts or checkpoints. Treat
  `estimated_counterfactual` values as bounded no-action estimates, not an
  observed alternate day.
- The inventory action's `evidence_records` contain no customer identity. Camel
  counts unique offer IDs, then counts only records with a unique completed POS
  receipt. The offer-to-purchase rate is linked receipts divided by recorded
  offers. Do not describe either count as unique customers.
- Sales on completed POS receipts linked to alternative offers are already
  included in observed net sales. Present them only as supporting evidence for
  the inventory intervention; never add them to net sales again or claim they
  are incremental sales against an unobserved control day.
- Never add estimated retained revenue to linked alternative-product purchases or to
  observed net sales. Keep observed and estimated value separate.

- Keep observed sales variance separate from estimated opportunity cost. The
  measures can overlap and must never be added together.
- Describe opportunity cost as **estimated revenue at risk**, never confirmed
  lost sales. Preserve the returned low and high values and state the supplied
  assumptions.
- Treat unserved product requests as observed demand signals, not confirmed
  abandoned purchases.
- Use authoritative incident timestamps to describe response time. Do not
  infer when a lane, assignment, or recovery began from the 15-minute samples.
- Compare multiple signals to propose tomorrow priorities, but call a
  relationship a contributing factor or planning risk unless the connector
  explicitly supplies causation.
- Every recommendation must cite at least two returned facts when it connects
  different operating areas. Do not invent inventory, weather, staffing,
  promotion, demand, cost, or task-system facts.
- Tomorrow's recommendations are proposals only. This contract exposes
  historical synthetic receipts and approvals, but it has no action endpoint
  and cannot approve or execute a new task.

## Errors

`400` means the request is invalid, `404` means the store or date is unknown,
and `500` means the fixture or simulator is invalid. Stop on an error. Do not
change the identity, call the host-only simulation path, query another system,
or substitute an earlier conversation or OpenViking memory.
