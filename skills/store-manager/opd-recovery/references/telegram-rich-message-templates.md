# Telegram rich-message templates

## Contents

- Formatting rules
- OPD diagnostic and recovery view
- Unavailable OPD view

## Formatting rules

Use these templates only to arrange fields returned by the packaged helper.
The braces describe source fields; they are not literal output or a templating
language. Render the content inside each example without its enclosing code
fence. Omit sections with no returned data. Never add a cause, staffing
scenario, forecast, promise, sent message, or completed action.

Use Rich Markdown because Hermes sends raw agent Markdown through Telegram's
native rich-message path when a response contains a table, task list, or
`<details>` block. Keep the message readable if Hermes falls back to Markdown.

- Keep words with every emoji. Use `⚠️` for an observed risk or unavailable
  view, `✅` for an observed within-target status, `📊` for measurements, `🔎`
  for returned causes or constraints, `💡` for a supplied recommendation, `🔮`
  for a forecast, `⏱️` for a proposed follow-up, `📝` for an unsent draft, and
  `🕒` for source timestamps. Use `📦` only for inventory evidence or a neutral
  operating-status heading.
- Use bold only for status, material gaps, the supplied recommendation, and
  the fact that the draft has not been sent.
- Keep tables to five short columns or fewer. Put long order reasons in
  bullets instead of table cells.
- Label forecast values as projected and keep them separate from observations.
- Use `<details>` only for secondary blockers, the unsent draft, and source
  timestamps. Never hide current performance or the proposed recovery plan.
- Do not use custom emoji IDs, media, links, code fences, or raw HTML styling.

## OPD diagnostic and recovery view

Choose the heading only from `opd_status.status`: use `⚠️ OPD needs attention`
for an at-risk status, `✅ OPD is within target` for a healthy status, and
`📦 OPD operating status` for any other returned value.

```markdown
# {{status emoji and plain-language heading}}

**{{store.store_name}}** · {{store_id}} · {{business_date}}

## 📊 Current performance

| Measurement | Observed | Target | Gap |
|---|---:|---:|---:|
| Pick rate | {{opd_status.picking.current_pick_rate_items_per_hour}} items/hour | {{opd_status.picking.target_pick_rate_items_per_hour}} items/hour | **{{opd_status.picking.pick_rate_gap_items_per_hour}} items/hour** |
| First pick | {{opd_status.first_pick.actual_started_at}} | {{opd_status.first_pick.target_started_at}} | **{{opd_status.first_pick.late_start_minutes}} min late** |

| Demand in operating window | Returned value |
|---|---:|
| Items due | {{opd_status.demand.items_due_in_window}} |
| Orders due | {{opd_status.demand.orders_due_in_window}} |
| Items waiting to be picked | **{{opd_status.demand.items_in_pick_queue}}** |
| Current pickers | {{opd_status.picking.current_pickers}} |

## 🔎 Why recovery is needed

**Fulfillment coverage:** {{execution_constraints.fulfillment_coverage.scheduled_headcount}} scheduled vs {{execution_constraints.fulfillment_coverage.required_headcount}} needed during {{execution_constraints.fulfillment_coverage.time_window}}; gap **{{execution_constraints.fulfillment_coverage.coverage_gap}}**.

{{one bullet per execution_constraints.at_risk_orders item: order reference, promise time, and returned risk reason}}

<details><summary>📦 Inventory blockers linked to at-risk orders</summary>

| Product | Department | On hand | Status |
|---|---|---:|---|
{{one row per execution_constraints.inventory_blockers item, using only returned fields}}

</details>

## 💡 Supplied recovery plan

> **{{recovery.recommended_action}}**

- **Suggested owner:** {{recovery.owner_role}}
- **People proposed:** {{recovery.additional_cross_trained_associates}}
- [ ] Proposed only — no staffing change has been executed

## 🔮 Forecast — projected, not observed

| Scenario | People added | Pick rate | Capacity | Result against demand |
|---|---:|---:|---:|---|
| Continue at current rate | None | {{recovery.forecast.without_redeployment_pick_rate_items_per_hour}}/hour | {{recovery.forecast.without_redeployment_projected_capacity_items}} | Shortfall: {{recovery.forecast.without_redeployment_projected_shortfall_items}} |
| Use supplied plan | {{recovery.additional_cross_trained_associates}} | {{recovery.forecast.with_recommended_redeployment_pick_rate_items_per_hour}}/hour | {{recovery.forecast.with_recommended_redeployment_projected_capacity_items}} | Buffer: {{recovery.forecast.with_recommended_redeployment_projected_buffer_items}} |

**Forecast window:** {{recovery.forecast.window_minutes}} minutes · **Returned demand:** {{recovery.forecast.items_due_in_window}} items

## ⏱️ Suggested follow-up

At **{{recovery.checkpoint.at}}**, check for at least **{{recovery.checkpoint.minimum_pick_rate_items_per_hour}} items/hour** and no more than **{{recovery.checkpoint.maximum_remaining_pick_queue_items}} items waiting**.

<details><summary>📝 Draft message — not sent</summary>

**To:** {{recovery.owner_role}}

{{factual draft built only from recovery.recommended_action, recovery.owner_role, and recovery.checkpoint}}

</details>

<details><summary>🕒 Data timestamps</summary>

- **OPD operations:** {{freshness.opd_operations}}
- **Orders:** {{freshness.orders}}
- **Workforce:** {{freshness.workforce}}
- **Inventory:** {{freshness.inventory}}

</details>
```

## Unavailable OPD view

```markdown
# ⚠️ OPD recovery view unavailable

**Unavailable data:** {{plain-language description of the helper's reported missing section}}

**Reported error:** {{exact helper error without credentials or endpoint details}}

No earlier briefing, conversation response, or memory was substituted. Retry after the connector owner resolves the reported issue.
```
