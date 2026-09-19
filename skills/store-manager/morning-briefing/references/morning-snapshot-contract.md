# Store Manager morning snapshot contract

Use this reference only with the Store Manager skill's packaged helper. The
helper calls the private Apache Camel endpoint
`/v1/store-morning-snapshot` through the deployment's private synthetic REST
policy. The current response contract is `0.3.0`.

## Request

```json
{
  "store_id": "<configured-store-id>",
  "business_date": "<YYYY-MM-DD>"
}
```

- `store_id` is a retailer-defined store identifier.
- `business_date` is the store-local date in `YYYY-MM-DD` form.
- Both fields are required. Do not use a current UTC date unless it is also
  the requested store-local date.
- The installed helper supplies `store_id` and the active synthetic demo
  `business_date` from its configuration when their arguments are omitted. An
  explicitly supplied store must match that configured assignment.

## Response fields

| Field | Meaning | Briefing treatment |
| --- | --- | --- |
| `store` | Name, city, time zone, and opening hours for the requested store. | Use the name and ID in the heading. Do not invent an opening time. |
| `freshness` | One source timestamp each for store/planning, POS, inventory, orders, workforce, safety observations, OPD operations, opening conditions, and prior-day service performance. | Report the timestamps in one compact footer. There is no universal SLA in this contract. |
| `yesterday_trade` | Completed trade date, net sales, plan, variance, variance percentage, transactions, and average basket. | State performance against plan; preserve the returned sign. |
| `today` | Current-day sales plan and optional promotion. | State the plan and promotion as returned. |
| `opening_leadership` | Opening Lead and Coach assignments with display name, role, covered departments, shift, and current status. | Identify who owns each department at opening. Do not infer attendance beyond the returned status. |
| `store_condition` | Overall opening-readiness status, checked-area counts, individual checks, and major issues with owners and target times. | State the overall condition and unresolved major issues. Keep safety events governed by the separate `safety` section. |
| `overnight_carryover` | Unfinished work handed over from the overnight team, including department, quantity, owner role, and target time. | State only open carryover and deduplicate it when the same work appears as a major store-condition issue. |
| `inventory_exceptions` | Up to three prioritized products whose stock state is not healthy. | Prioritize `out_of_stock` and `high` priority before lower-impact items. |
| `not_in_location` | Aggregate overnight location-scan counts, current and recent-average rates, unresolved count, trend, and department distribution. | Describe the measured trend and the department with the most unresolved detections. A not-in-location detection is not proof that inventory is unavailable. |
| `fulfillment` | Order counts due today and at risk, plus up to three at-risk exceptions. | State at-risk count and the most actionable returned reason/reference. |
| `opd` | Opening OPD status, items and orders due, items waiting to be picked, first-pick timing, at-risk order count, and prior-day customer/driver dispensing waits. | State backlog and delay facts without presenting the morning brief as a recovery diagnosis. Compare waits only with the returned store targets. |
| `customer_waits` | Prior-day checkout average and peak wait, peak window, returned store target, and customers above target. | State the peak and when it occurred; label the measurement date. |
| `traffic` | Prior-day hourly transaction series reconciled to the daily transaction total, plus the peak hour. | Use the peak and surrounding hourly pattern as scheduling evidence, not as a forecast. |
| `staffing_gaps` | Up to two shortfalls with department, time window, scheduled/required headcount, and `coverage_gap`. | State the time window and numeric gap. |
| `safety` | A reporting window, privacy declaration, deterministic summary, and up to six normalized hazard or incident events. | Put unresolved critical and high-severity safety events before operational exceptions. Clearly distinguish observations from confirmed events. |

## OPD dispensing fields

`opd.dispensing_waits` contains a prior-day measurement window and separate
`customer_pickup` and `delivery_driver` measurements. Each group returns its
completed handoff count, store-defined maximum wait target, average wait, peak
wait, and count above target. Do not combine the two populations or present a
peak as an average.

## Not-in-location meaning

A not-in-location detection means a location scan did not find an item where
the system expected it on the salesfloor. It may indicate misplaced product,
replenishment work, a location-data issue, or an actual availability problem.
The contract supplies aggregate detections only; do not claim a root cause or
equate the count with confirmed stockouts.

## Safety event fields

| Field | Meaning |
| --- | --- |
| `classification` | `hazard` is a dangerous condition; `incident` records something that occurred. |
| `event_type` and `description` | Stable type and plain-language source description. |
| `location` | A store zone ID and human-readable location. |
| `severity` | Deterministic source severity: `critical`, `high`, `medium`, or `low`. |
| `status` | Lifecycle state such as `awaiting_verification`, `response_dispatched`, `cleared`, or `false_positive`. |
| `verification.status` | Whether a person has confirmed the computer-vision observation. |
| `observation` | Source type and detection confidence. Confidence is not severity or confirmation. |
| `response` | The returned store playbook, target response time, and bounded recommended response. |
| `resolution` | Present only when the source supplies a clearance time and recorded outcome. |

The `safety.summary` counts events needing attention, active hazards and
incidents, observations awaiting verification, incidents since the previous
close, cleared events, and false positives. The `safety.privacy` declaration
confirms that this bounded snapshot contains neither images nor person
identifiers.

## Interpretation rules

- All returned values are facts from the connector at its listed timestamp.
- Do not calculate a freshness status without an agreed deployment threshold.
- Do not correlate a stock exception with an at-risk order unless the snapshot
  explicitly supplies that link in `risk_reason`.
- Treat an unverified computer-vision event as a **possible** hazard or
  incident. A confidence score does not confirm it.
- Do not infer an injury, cause, identity, completed response, or cleared area.
  State those only when the event's verification, status, or resolution returns
  them.
- Use only the returned safety playbook. An event with
  `response_dispatched` needs an outcome check, not a duplicate dispatch. A
  `cleared` or `false_positive` event is context, not an active priority.
- Do not claim a root cause for sales variance; the contract supplies no cause.
- Do not turn prior-day hourly transactions into a demand forecast. Use them
  only as scheduling context for the returned time windows.
- Treat opening-leadership status literally: `scheduled` is not proof that the
  person is on site, while `on_site` is a returned source status.
- Keep OPD customer pickup and delivery-driver waits separate and preserve
  whether a value is an average or a peak.
- Currency codes are not part of version `0.3.0`. Retain the deployment's
  local currency convention; if it is unknown, show the numeric value without
  naming a currency.

## Error responses

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Missing inputs or an invalid business-date format. |
| `404` | `store_not_found` | The connector has no data for the requested store. |
| `404` | `business_date_not_found` | The connector has no plan/data for the requested date. |
| `500` | `connector_error` | The connector could not read its source data. |

Stop on an error rather than issuing a broader request, changing the endpoint,
or querying another system.
