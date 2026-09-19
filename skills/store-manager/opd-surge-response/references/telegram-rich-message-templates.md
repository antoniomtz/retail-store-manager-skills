# Telegram rich-message templates

## Contents

- Formatting rules
- New OPD exception
- Manager review
- Current OPD status
- Verified action receipt
- Rejected decision
- Follow-up result

## Formatting rules

Use these templates only to arrange values returned by the packaged helper.
The braces describe source fields; they are not literal output or a templating
language. Render the content inside each example without its enclosing code
fence. Omit sections with no returned data. Never invent an event, plan,
approval, action, receipt, or measured result.

Use Rich Markdown because Hermes sends raw agent Markdown through Telegram's
native rich-message path when a response contains a table or task list. Keep
the message readable if Hermes falls back to Markdown.

- Keep words with every emoji. Use only the template emojis: `🚨` exception,
  `📊` measurements, `🔎` observed change, `✅` recommendation or verified
  success, `📋` plan choices, `⚖️` operational impact, `🗳️` manager decision,
  `🔄` fresh read, `📬` receipt, `👥` staffing, `⏱️` follow-up, `🧭` next step,
  `⏸️` rejection, `⚠️` missed target, and `🟢` normal operation.
- Use bold only for breached values, the recommendation, verified execution,
  and measured outcome.
- Keep tables to five short columns or fewer. Put full actions and operational
  impact in bullets below the table.
- Use task lists only for checks the helper explicitly verifies.
- Never present a projection as an observation. Never hide a required manager
  decision or missed result inside `<details>`.
- Do not use custom emoji IDs, media, links, code fences, or raw HTML styling.

## New OPD exception

```markdown
# 🚨 OPD decision needed

**{{operating_state.store.store_name}}** · {{operating_state.store_id}} · {{operating_state.business_date}}

Decision `{{decision.decision_id}}`

## 📊 Current conditions

| Measurement | Current | Normal pace |
|---|---:|---:|
| Items due | **{{operating_state.metrics.items_due_in_window}}** | — |
| Orders due | {{operating_state.metrics.orders_due_in_window}} | — |
| Items waiting to be picked | **{{operating_state.metrics.items_in_pick_queue}}** | — |
| Pickers working | {{operating_state.metrics.current_pickers}} | — |
| Pick rate | **{{operating_state.metrics.current_pick_rate_items_per_hour}}/hour** | {{operating_state.metrics.target_pick_rate_items_per_hour}}/hour |

**Recovery check after {{operating_state.recovery_context.checkpoint_after_minutes}} minutes:** at least **{{operating_state.recovery_context.minimum_pick_rate_items_per_hour}} items/hour** with no more than **{{operating_state.recovery_context.maximum_remaining_pick_queue_items}} items waiting**.

## 🔎 What changed

{{one bullet per operating_state.active_events item, using its label and returned event measurements}}

## ✅ Recommended plan

> **{{recommended_plan.title}}**
>
> {{recommended_plan.action}}

**Why Hermes recommends it:** {{decision.recommendation_reason}}

- **People assigned:** {{recommended_plan.additional_associates}}
- **For:** {{recommended_plan.assignment_duration_minutes}} minutes
- **Expected extra pick capacity:** {{recommended_plan.incremental_pick_rate_items_per_hour}} items/hour
- **Expected after {{recommended_plan.projection_horizon_minutes}} minutes:** {{recommended_plan.projected_pick_rate_items_per_hour}} items/hour and {{recommended_plan.projected_queue_at_checkpoint_items}} items waiting

## 📋 Available plans

| Plan | People assigned | For | Expected pick rate | Expected queue |
|---|---:|---:|---:|---:|
{{one row per decision.feasible_plans item, using only returned fields}}

## ⚖️ What changes elsewhere

- {{decision.tradeoff_summary}}
{{additional bullets from recommended_plan.tradeoffs only when they add distinct returned detail}}

---

🗳️ **Next step:** Send **Review OPD decision** in this chat to open the action buttons.
```

## Manager review

Repeat the same `📋 Available plans` table and exact per-plan values used in
the alert. Then add:

```markdown
🔄 **Freshness check:** These choices were read from current OPD state at {{operating_state.simulated_at}} so an outdated plan cannot be approved.

🗳️ **Decision:** `{{decision.decision_id}}`
```

Call `clarify` immediately afterward with the exact returned labels. Do not
draw fake buttons in Markdown.

## Current OPD status

Choose the heading from `operating_status`: `🟢 OPD is within target` for
normal operation, `🚨 OPD needs attention` for an active incident, `🗳️ OPD is
waiting for a manager decision` when approval is pending, `⏱️ OPD recovery is
awaiting a follow-up measurement` after an approved action, `✅ OPD recovery
worked` for a met follow-up, and `⚠️ OPD recovery needs attention` for a missed
follow-up.

```markdown
# {{status emoji and plain-language heading}}

**{{store.store_name}}** · {{store_id}} · {{business_date}}

## 📊 Current conditions

| Measurement | Current | Normal pace |
|---|---:|---:|
| Items due | {{metrics.items_due_in_window}} | — |
| Items waiting to be picked | {{metrics.items_in_pick_queue}} | — |
| Pickers working | {{metrics.current_pickers}} | — |
| Pick rate | {{metrics.current_pick_rate_items_per_hour}}/hour | {{metrics.target_pick_rate_items_per_hour}}/hour |

{{when an incident is active, state separately: Recovery check after recovery_context.checkpoint_after_minutes minutes: at least recovery_context.minimum_pick_rate_items_per_hour items/hour and no more than recovery_context.maximum_remaining_pick_queue_items items waiting.}}

{{one concise next step selected only from monitor.action and current decision/checkpoint state}}
```

## Verified action receipt

Use this only when `external_action_executed` and `receipt_verified` are both
true.

```markdown
# ✅ OPD action accepted

**{{selected_plan.title}}**

{{selected_plan.action}}

## 📬 Verified receipt

- [x] Manager approval matched decision `{{decision.decision_id}}`
- [x] {{action_receipt.external_system}} accepted receipt `{{action_receipt.receipt_id}}`
- [x] A fresh OPD status read verified the same receipt

## 👥 Change applied

| Change | Confirmed value |
|---|---:|
| People assigned to OPD | {{action_receipt.applied_change.temporary_associates_assigned}} |
| Added pick capacity | {{action_receipt.applied_change.incremental_pick_rate_items_per_hour}} items/hour |
| Assignment duration | {{action_receipt.applied_change.assignment_duration_minutes}} min |

## ⏱️ Follow-up measurement

Early progress check scheduled for **{{checkpoint.due_at}}**, after
**{{checkpoint.after_minutes}} minutes**. Hermes will compare observed pick
rate and queue with the returned targets, but will not call the recovery
complete until the **{{checkpoint.assignment_duration_minutes}}-minute**
assignment ends and its final outcome is measured.
```

## Rejected decision

Use this only after an explicit rejection when
`external_action_executed` is false.

```markdown
# ⏸️ OPD plan declined

- [x] Decision `{{decision.decision_id}}` was rejected
- [x] No staffing action ran

The current OPD condition remains visible. Another action requires a new current decision and explicit manager approval.
```

## Follow-up result

For stage `progress`, use `⏱️ OPD recovery is on track` when status is `met`
and `⚠️ OPD early recovery check missed` for `missed`. Do not say recovery is
complete. For stage `final`, use `✅ OPD recovery worked` only for `met` and
`⚠️ OPD recovery needs attention` for `missed`.

```markdown
# {{status emoji and plain-language heading}}

## 📊 Follow-up measurement

Label this **Early progress check** for stage `progress` and **Final assignment
outcome** for stage `final`.

| Measurement | Observed | Target |
|---|---:|---:|
| Pick rate | {{checkpoint.measured_pick_rate_items_per_hour}}/hour | At least {{checkpoint.minimum_pick_rate_items_per_hour}}/hour |
| Items waiting to be picked | {{checkpoint.measured_remaining_pick_queue_items}} | No more than {{checkpoint.maximum_remaining_pick_queue_items}} |

## 🧭 What happens next

{{checkpoint.guidance}}
```
