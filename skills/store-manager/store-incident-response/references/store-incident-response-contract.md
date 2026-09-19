# Store incident response contract

Use this reference only with the packaged `store-incident-response` helper.
The helper sends a bounded visual classification to the private synthetic
Camel endpoint `/v1/store-incident-response-plans`. The image is sent only
through Hermes's configured vision-model path and is never part of the Camel
request.

## Request

The helper supplies the configured `store_id` and `business_date`. The agent
supplies only these enums after Hermes vision analyzes the exact current image.
They are a validation schema, not default incident facts. A value from an
installer probe, example, previous image, conversation, filename, or memory is
not valid request evidence.

| Field | Allowed values |
| --- | --- |
| `hazard_class` | `spill`, `obstruction`, `damaged_fixture`, `smoke_or_fire`, `possible_injury`, `security`, `unknown` |
| `severity` | `low`, `medium`, `high`, `critical` |
| `zone` | `front_entrance`, `checkout`, `sales_floor`, `stockroom`, `parking_lot`, `unknown` |
| `customer_exposure` | `none`, `possible`, `present` |
| `access_impact` | `clear`, `partially_blocked`, `blocked` |
| `confidence` | `low`, `medium`, `high` |

Do not add a visual narrative, person description, image URL, local path,
biometric feature, free-form instruction, or action authorization.

## Response

| Field | Meaning | Treatment |
| --- | --- | --- |
| `visual_assessment` | Exact echo of the submitted enums. | Pair it with observable image evidence; do not treat an enum as a verified diagnosis. |
| `planning_guardrails` | Confirms Camel received no image, permits no identity or protected-attribute inference, and authorizes no action. | Preserve every false authorization flag. |
| `incident_policy` | Response priority, resource, immediate controls, and escalation conditions from the synthetic safety playbook. | Never weaken or hide a returned escalation condition. |
| `associate_availability.available` | Synthetic associates currently available, with capabilities, ETA, commitments, and reassignment impact. | Use only members included in a feasible plan. |
| `associate_availability.protected` | Synthetic associates unavailable because another active commitment is protected. | Never select or imply availability. |
| `feasible_plans` | One or two deterministically valid response teams, assignments, readiness, immediate actions, protected commitments, and coverage tradeoffs. | Hermes chooses one using current image evidence and the skill's judgment rules. |
| `blocked_options` | Plan strategies that could not satisfy required capabilities without violating availability. | Summarize only when useful; do not repair them yourself. |
| `selection_factors` | Returned constraints and comparison factors. | Use them as decision support, not as a preselected answer. |

`response_ready_in_minutes` is an estimated synthetic team-readiness value, not
proof that anyone was dispatched or arrived. `coverage_tradeoffs` describe
what changes if a proposal is later executed; they are not current changes.

## Error responses

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | A required value is missing or outside its enum. |
| `404` | `store_not_found` | No fixture exists for the configured store. |
| `404` | `business_date_not_found` | No fixture exists for the configured date. |
| `409` | `no_feasible_response` | No available synthetic team satisfies the required capabilities. |
| `500` | `connector_error` | The fixture or planner could not be read. |

Stop on an error. Do not broaden the request, substitute protected associates,
or make a plan from general knowledge.
