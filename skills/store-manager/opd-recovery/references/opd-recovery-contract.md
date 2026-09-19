# Store Manager OPD recovery contract

Use this reference only with the OPD Recovery skill's packaged helper. The
helper calls the private Apache Camel endpoint `/v1/store-opd-recovery` through
the deployment's private synthetic Camel REST endpoint.

## Request

```json
{
  "store_id": "<configured-store-id>",
  "business_date": "<YYYY-MM-DD>"
}
```

- `store_id` is a retailer-defined store identifier.
- `business_date` is the store-local date in `YYYY-MM-DD` form.
- Both fields are required.
- The installed helper supplies `store_id` and the active synthetic demo
  `business_date` from its configuration when their arguments are omitted. An
  explicitly supplied store must match that configured assignment.

## Response fields

| Field | Meaning | Recovery treatment |
| --- | --- | --- |
| `store` | Name, city, time zone, and opening hours for the requested store. | Use the name and ID in the heading. |
| `freshness` | Source timestamps for OPD operations, orders, workforce, and inventory. | Report the timestamps. Do not label data current or stale without an agreed threshold. |
| `opd_status` | Observed OPD state, recovery window, first-pick timing, demand, and pick-rate gap. | State the returned status and facts without inferring an unreturned cause. |
| `execution_constraints.at_risk_orders` | At-risk orders due on the business date, including the source-supplied risk reason. | Use the returned order references and reasons only. |
| `execution_constraints.fulfillment_coverage` | Fulfillment staffing coverage for its returned time window. | State the returned scheduled, required, and coverage-gap values. |
| `execution_constraints.inventory_blockers` | Non-healthy products explicitly named in a returned at-risk order reason. | Treat the supplied link as evidence; do not associate other stock exceptions with OPD risk. |
| `recovery` | Recommended role, workforce-supplied temporary capacity, non-executed action, deterministic forecast, and checkpoint. | Label the action as recommended and the forecast as projected. Do not claim that anyone was assigned. |

## Forecast interpretation

`recovery.forecast` is a deterministic capacity calculation supplied by the
connector for the returned operating window. It compares the observed current
pick rate with the recommended temporary redeployment. It is a forecast, not
an observed result or authorization to change staffing.

- `without_redeployment_*` describes the current-rate projection.
- `with_recommended_redeployment_*` describes only the returned recommended
  number of additional associates at the returned per-associate rate.
- Do not calculate a different staffing scenario, claim a service-level
  outcome, or turn the recommended action into a completed action.
- At the returned checkpoint, state the supplied minimum pick rate and maximum
  remaining queue as the manager's suggested check, not a completed follow-up.

## Error responses

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Missing inputs or an invalid business-date format. |
| `404` | `store_not_found` | The connector has no data for the requested store. |
| `404` | `business_date_not_found` | The connector has no data for the requested date. |
| `500` | `connector_error` | The connector could not read its source data. |

Stop on an error rather than changing the endpoint or querying another system.
