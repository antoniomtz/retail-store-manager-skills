# Telegram rich-message templates

## Contents

- Formatting rules
- Completed end-of-day review
- Simulation not ready
- Unavailable review

## Formatting rules

Use these templates only to arrange current values returned by the packaged
helper. Braces describe source fields; they are not literal output or a
templating language. Render the content inside an example without its code
fence. Never invent a metric, incident, causal claim, estimate, forecast,
recommendation input, action, or completed task.

Use Rich Markdown because Hermes sends raw agent Markdown through Telegram's
native rich-message path when a response contains a table or `<details>`
block. Keep the response readable if Hermes falls back to ordinary Markdown.

- Keep words with every emoji. Use `🌙` for the review, `✅` for completed
  actions, `⚠️` for remaining gaps, and `🧭` for tomorrow's priorities.
- Use bold only for material variances, breached results, estimated ranges,
  and the ranked recommendation titles.
- Use one table with exactly three rows and two columns. Pair each completed
  operating action with its observed business result.
- Keep observations, estimates, and proposals clearly labeled.
- Keep the completed response under 220 words. Do not use `<details>` blocks or
  reproduce hourly results, full incident lists, full stockout lists, or
  evidence timestamps.
- Do not use task-list checks because this read-only workflow executes no
  action. Do not use custom emoji IDs, media, links, or raw HTML styling.

## Completed end-of-day review

```markdown
# 🌙 Daily business impact

**{{store.store_name}}** · {{store_id}} · {{business_date}}

> **{{one plain sentence led by the strongest observed before-and-after action result}}**

## ✅ What went well

| Action taken | Business result |
|---|---|
| Checkout capacity | {{checkout action taken}}. Peak wait fell from {{checkout action measured.peak_wait_before_minutes}} to {{checkout action measured.maximum_wait_at_recovery_minutes}} minutes, and {{recovered checkout incident count}} queue surges recovered. |
| Online-order coverage | {{online-order action taken}}. Picking increased from {{OPD action measured.pick_rate_before_items_per_hour}} to {{OPD action measured.pick_rate_at_checkpoint_items_per_hour}} items per hour. |
| Product availability | {{inventory action taken}}. {{inventory action measured.linked_completed_purchases}} of {{inventory action measured.alternative_offers_recorded}} offers resulted in completed purchases ({{inventory action measured.offer_to_purchase_rate_percent}}%), representing {{inventory action measured.sales_from_linked_purchases}} in sales. |

**Estimated impact avoided:** {{checkout action estimated_counterfactual.customers_avoiding_excess_wait}} additional long waits and {{OPD action estimated_counterfactual.late_orders_avoided}} additional late orders.

## ⚠️ What needs attention

- Sales closed at {{sales.net_sales}}, {{absolute sales.variance}} ({{absolute sales.variance_percent}}%) {{above or below}} the {{sales.sales_plan}} goal.
- {{one plain sentence stating requests for products that remained unfulfilled}}.
- {{one plain sentence stating the late-order or staffing gap that remained}}.

## 🧭 Priorities for tomorrow

1. **{{concise action and timing}}** — {{strongest evidence and expected business benefit}}.
2. **{{concise action and timing}}** — {{strongest evidence and expected business benefit}}.
```

## Simulation not ready

```markdown
# ⚠️ End-of-day review not ready

No completed store-day data is available for **{{store.store_name}}** on {{business_date}}.

From the repository host, run:

`use-cases/store-manager/scripts/simulate-store-day.sh run`

Then ask for the end-of-day operating review again. No earlier conversation, morning briefing, operating demo, or memory was substituted.
```

## Unavailable review

```markdown
# ⚠️ End-of-day review unavailable

**Reported error:** {{exact helper error without credentials or endpoint details}}

No partial or earlier store day was presented. Retry after the connector owner resolves the reported issue.
```
