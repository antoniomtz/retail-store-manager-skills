# Telegram rich-message templates

## Contents

- Formatting rules
- Morning briefing
- Unavailable briefing

## Formatting rules

Use these templates only to arrange fields returned by the packaged helper.
The braces describe source fields; they are not literal output or a templating
language. Render the content inside each example without its enclosing code
fence. Omit sections with no returned data. Never invent a value, cause,
relationship, completed action, or recommendation unsupported by the skill's
recommendation rules.

Use Markdown constructs supported by Telegram's native rich-message path. This
rendering is intended for a Telegram-originated request or an explicitly
requested TUI-to-Telegram delivery.

- Keep words with every emoji. Use `🌅` for the briefing, `🚨` for immediate
  priorities, `👥` for leadership, `🏪` for store readiness, `📦` for OPD and
  service, `📈` for traffic and trade, and `⚠️` for unavailable data. Use `🔴`
  for returned critical or high severity, `🟠` for medium, and `🟡` for low;
  always include the severity word.
- Use bold only for the store, material variance, exception status, and the
  concrete next step in each recommendation.
- Use only the two compact tables shown below. Keep store readiness and traffic
  as short bullets. Put operating judgment in the ranked priorities, not in
  additional sections.
- State each source fact once. In a priority, name the action and the single
  fact that creates urgency; do not reproduce a full row or bullet.
- Do not add secondary evidence or timestamp sections. Do not emit raw HTML or
  `<details>` tags.
- Format money with the deployment's established local convention. When none
  is established, preserve the returned number without inventing a currency.
- Do not use custom emoji IDs, media, links, code fences, or raw HTML styling.

## Morning briefing

```markdown
# 🌅 Morning briefing

**{{store.store_name}}** · {{store_id}} · {{business_date}}

> **{{one plain sentence naming the most urgent opening outcome and the most important customer or business risk}}**

## 🚨 Open first

{{numbered list of up to three supported priorities in ranked order; use this compact shape for each item:}}

1. **{{concise manager action, including returned timing when material}}** — {{one short evidence clause explaining the urgency.}}

## 👥 Opening team

| Department | Lead or Coach | Shift · status |
|---|---|---|
| {{group departments only when the same person covers them}} | {{display_name}} · {{role}} | {{shift}} · {{plain-language on_site or scheduled status}} |

## 🏪 Store readiness

- **Condition:** {{areas_ready}} of {{areas_checked}} areas ready. {{up to two major issues and open overnight carryover, stated once with owner and target time.}}
- **Coverage:** {{each staffing gap in plain language: department, window, scheduled, needed, and shortage.}}
- **Availability:** {{unresolved not_in_location count and current rate versus recent average; name the department with the most unresolved detections. Mention a confirmed inventory exception only when it is a ranked priority.}}
- **Safety:** {{the highest-priority unresolved safety observation or incident and the count of any others needing attention; otherwise state that none need attention.}}

## 📦 OPD and customer service

| Measure | Result |
|---|---|
| Opening workload | {{items waiting to be picked, items and orders due in the returned window, first-pick delay, and orders at risk.}} |
| Pickup customers | {{prior-day average and peak dispensing wait versus the customer target.}} |
| Delivery drivers | {{prior-day average and peak dispensing wait versus the driver target.}} |
| Checkout | {{prior-day peak wait, target, peak window, and customers above target.}} |

## 📈 Traffic and trade

- **Scheduling signal:** {{prior-day peak transaction hour and count; add an adjacent high-volume hour only when it materially clarifies the pattern. This is context, not a forecast.}}
- **Sales:** Yesterday {{yesterday_trade.net_sales}}, {{absolute yesterday_trade.sales_variance}} ({{absolute yesterday_trade.sales_variance_percent}}%) {{above or below}} goal. Today {{today.sales_plan}}. {{promotion only when returned and material.}}

_Data captured: opening {{freshness.opening_conditions}}; planning {{freshness.store_and_planning}}; OPD {{freshness.opd_operations}}; inventory {{freshness.inventory}}; orders {{freshness.orders}}; staffing {{freshness.workforce}}; service {{freshness.service_performance}}; safety {{freshness.safety}}; prior-day sales and traffic {{freshness.pos}}._
```

## Unavailable briefing

```markdown
# ⚠️ Morning briefing unavailable

**Unavailable data:** {{plain-language description of the helper's reported missing section}}

**Reported error:** {{exact helper error without credentials or endpoint details}}

No older briefing or memory was substituted. Retry after the connector owner resolves the reported issue.
```
