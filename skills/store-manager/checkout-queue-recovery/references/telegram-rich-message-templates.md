# Telegram rich-message templates

## Contents

- Formatting rules
- New checkout exception
- Manager review
- Current checkout status
- Verified action receipt
- Rejected decision
- Updated plan
- Follow-up result

## Formatting rules

Use these templates only to arrange values returned by the packaged helper.
The braces describe source fields; they are not literal output and are not a
templating language. Omit a section when its source field is absent. Never add
a value, fact, conclusion, URL, or action that the helper did not return.
Render the content inside each example; never include its enclosing
`markdown` code fence in the Telegram response.

Use Rich Markdown because Hermes sends raw agent Markdown through Telegram's
native rich-message path when a response contains a table, task list, or
`<details>` block. Keep the message readable if Hermes falls back to Markdown:

- Use one meaningful emoji per heading. Keep the words so color and emoji are
  never the only status signal.
- Use only the template emojis. They have stable roles: `🚨` exception, `📊`
  measurements, `🔎` evidence, `✅` recommendation or success, `📋` plans,
  `⚖️` operational impact, `🚫` blocked option, `🗳️` decision, `🔄` refresh,
  `📬` receipt, `👥` staffing change, `⏱️` follow-up, `🧭` next step, `⏸️`
  rejection, `⚠️` missed target, and `🟢` normal operation.
- Use bold sparingly for the recommendation, breached values, and outcome.
- Keep tables to five short columns or fewer. Put full actions and operational
  impact in bullets below the table. Table cells support inline formatting
  only.
- Use a task list only for checks that the helper explicitly confirms.
- Use `<details><summary>...</summary>...</details>` only for secondary blocked
  options. Never hide the recommendation, required approval, or failed result.
- Do not use custom Telegram emoji IDs, media, links, code fences, raw HTML
  styling, or decorative emoji on every bullet.

## New checkout exception

```markdown
# 🚨 Checkout decision needed

**{{operating_state.store.store_name}}** · {{operating_state.zone_name}}

Decision `{{decision.decision_id}}`

## 📊 Current conditions

| Measurement | Current | Store limit |
|---|---:|---:|
| People waiting | **{{operating_state.metrics.people_in_queue}}** | {{operating_state.thresholds.maximum_people_in_queue}} |
| Estimated wait | **{{operating_state.metrics.estimated_wait_minutes}} min** | {{operating_state.thresholds.maximum_estimated_wait_minutes}} min |
| Camera detection confidence | {{operating_state.metrics.vision_confidence}} | {{operating_state.thresholds.minimum_vision_confidence}} |

## 🔎 Why traffic is higher

{{operating_state.forecast.reason}}

**Why it may continue:** {{operating_state.forecast.evidence}}

## ✅ Recommended plan

> **{{recommended_plan.title}}**
>
> {{recommended_plan.action}}

**Why Hermes recommends this:** {{decision.recommendation_reason}}

- **People reassigned:** {{recommended_plan.associates_reassigned}}
- **For:** {{recommended_plan.assignment_duration_minutes}} minutes
- **Expected extra checkout capacity:** {{recommended_plan.incremental_throughput_customers_per_hour}} customers/hour
- **Expected after {{recommended_plan.projection_horizon_minutes}} minutes:** {{recommended_plan.projected_people_in_queue_at_checkpoint}} people waiting, {{recommended_plan.projected_wait_minutes_at_checkpoint}}-minute wait

## 📋 Available plans

| Plan | People reassigned | For | Expected queue | Expected wait |
|---|---:|---:|---:|---:|
{{one row per decision.feasible_plans item, using only returned fields}}

## ⚖️ What changes elsewhere

{{decision.tradeoff_summary}}

{{one supporting bullet per recommended_plan.tradeoffs item}}

<details><summary>🚫 Why another option is blocked</summary>

{{one short bullet per decision.blocked_options item and its blocked_reasons}}

</details>

---

🗳️ **Next step:** Send **Review checkout decision** in this chat to open the action buttons.
```

## Manager review

Use the same `📋 Available plans` table and the same per-plan values used in
the exception alert. Include the exact persisted
`decision.recommendation_reason` and `decision.tradeoff_summary`; do not
paraphrase them. Then add:

```markdown
🔄 **Freshness check:** These choices were read from the current store state at {{operating_state.simulated_at}} so an outdated plan cannot be approved.

🗳️ **Decision:** `{{decision.decision_id}}`
```

Call `clarify` immediately after this message with the exact returned button
labels. Do not draw fake buttons in Markdown.

## Current checkout status

Choose the heading from `operating_status`: use `🟢 Checkout is within target`
for normal operation, `🚨 Checkout needs attention` for an active exception,
`🔎 Checkout recovery options are being evaluated` while Hermes is committing
its recommendation,
`🗳️ Checkout is waiting for a manager decision` for a pending decision, and
`⏱️ Checkout action is awaiting a follow-up measurement` after an approved
action. Use `✅ Checkout recovery worked` when the follow-up target was met and
`⚠️ Checkout recovery needs attention` when it was missed.

```markdown
# {{status emoji and plain-language heading}}

**{{store.store_name}}** · {{zone_name}}

## 📊 Current conditions

| Measurement | Current | Store limit |
|---|---:|---:|
| People waiting | {{metrics.people_in_queue}} | {{thresholds.maximum_people_in_queue}} |
| Estimated wait | {{metrics.estimated_wait_minutes}} min | {{thresholds.maximum_estimated_wait_minutes}} min |
| Staffed registers open | {{metrics.active_staffed_lanes}} | — |
| Self-checkout stations open | {{metrics.active_self_checkout_stations}} | — |

{{one concise next-step sentence selected only from monitor.action and current decision/checkpoint state}}
```

## Verified action receipt

Use this only when `external_action_executed` and `receipt_verified` are both
true.

```markdown
# ✅ Checkout action accepted

**{{selected_plan.title}}**

{{selected_plan.action}}

## 📬 Verified receipt

- [x] Manager approval matched decision `{{decision.decision_id}}`
- [x] {{action_receipt.external_system}} accepted receipt `{{action_receipt.receipt_id}}`
- [x] A fresh status read verified the same receipt

## 👥 Change applied

| Change | Confirmed value |
|---|---:|
| People reassigned | {{action_receipt.applied_change.associates_reassigned}} |
| Staffed registers opened | {{action_receipt.applied_change.staffed_registers_opened}} |
| Self-checkout helpers moved | {{action_receipt.applied_change.self_checkout_hosts_repositioned}} |
| Assignment duration | {{action_receipt.applied_change.assignment_duration_minutes}} min |

## ⏱️ Follow-up measurement

Scheduled for **{{checkpoint.due_at}}**. Hermes will compare the measured line and wait with the returned targets before calling the action successful.
```

## Rejected decision

Use this only when `external_action_executed` is false after an explicit
rejection.

```markdown
# ⏸️ Checkout plan declined

- [x] Decision `{{decision.decision_id}}` was rejected
- [x] No staffing or register change ran

The checkout condition remains under observation. A new event or manager request is required before another action can be considered.
```

## Updated plan

```markdown
# 🔄 Checkout plan updated

**Previous decision:** `{{previous_decision_id}}`

**New decision:** `{{decision.decision_id}}`

## 🧭 Manager instructions applied

{{one bullet per returned manager constraint}}

{{the same recommended-plan block and available-plans table used above}}

🗳️ **Next step:** Send **Review checkout decision** to approve, adjust, or reject the updated plan.
```

## Follow-up result

Choose the heading from the returned checkpoint status: use `✅ Checkout
recovery worked` for `met` and `⚠️ Checkout recovery needs attention` for
`missed`.

```markdown
# {{status emoji and plain-language heading}}

## 📊 Follow-up measurement

| Measurement | Observed | Target |
|---|---:|---:|
| People waiting | {{checkpoint.measured_people_in_queue}} | {{checkpoint.maximum_people_in_queue}} |
| Estimated wait | {{checkpoint.measured_estimated_wait_minutes}} min | {{checkpoint.maximum_estimated_wait_minutes}} min |

## 🧭 What happens next

{{checkpoint.guidance}}
```
