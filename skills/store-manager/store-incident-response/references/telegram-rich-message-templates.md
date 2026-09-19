# Telegram rich-message templates

## Contents

- Formatting rules
- Store incident assessment
- Unavailable assessment

## Formatting rules

Use these templates only to arrange current image observations and values from
the packaged helper. Braces describe source fields; they are not literal output
or a templating language. Render the content inside an example without its code
fence. Never invent a person, identity, hazard fact, qualification, availability,
response time, outcome, or completed action.

Use compact Rich Markdown. Hermes sends raw agent Markdown through Telegram's
native rich-message path when the response contains a GitHub-style table. Keep
the response useful if Hermes falls back to ordinary Markdown.

- Use one `#` H1 for the message title, one `##` H2 for the incident label,
  and `###` H3 headings for the evidence, recommendation, team, and safety
  sections. Telegram controls their rendered sizes; do not simulate sizing
  with repeated bold text or raw HTML.
- Keep words with every emoji. Use `👁️` for visual evidence, `🚨` for the
  incident, `✅` for the recommendation, `🛡️` for safety actions, and `⚠️` for
  an unavailable result.
- Use bold only for the assessment label, recommended plan, readiness, safety
  labels, and a material warning.
- Keep the `vision_analyze` description separate from the mapped assessment,
  helper facts, and the agent's judgment.
- Copy or closely shorten every physical object, condition, quantity, and
  location in the visual section from the current `vision_analyze` result.
  Never supplement that result by inspecting the image with the main model.
- Render access as `blocked` only when the current visual analysis establishes
  that no passable route remains or that a full entrance, exit, or emergency
  route is obstructed. Otherwise use the bounded value actually supported by
  the current evidence.
- Show only the selected team's returned roles and assignments in one compact,
  two-column table. Do not add a department, individual reference, per-person
  ETA, or separate impact section.
- Put one material returned tradeoff in the recommendation sentence. Omit the
  alternate plan, blocked options, protected-commitment inventory, freshness
  timestamp, and implementation provenance unless the user explicitly asks.
- Compress every returned immediate control and escalation condition into the
  two labeled safety lines. Never hide or omit an escalation condition.
- Do not use task-list checks because no physical action executes. Do not use
  custom emoji IDs, media links, local media directives, raw HTML, or decorative
  emoji on every row or line. The managed webhook cannot safely attach a local
  image through Hermes 0.19's cross-platform delivery path.

## Compact store incident assessment

```markdown
# 🚨 Store incident

## {{plain-language visual_assessment.hazard_class}} · {{plain-language visual_assessment.zone}}

### 👁️ What the photo shows

{{one to three concise sentences copied or closely shortened from the current visual analysis}}

**Assessment:** {{visual_assessment.severity}} severity · {{plain-language visual_assessment.customer_exposure}} · {{plain-language visual_assessment.access_impact}} · {{visual_assessment.confidence}} confidence

### ✅ Recommendation

> **{{selected feasible plan.title}}** · team ready in approximately **{{selected feasible plan.response_ready_in_minutes}} minutes**

{{one compact reasoning sentence connecting a visible fact, readiness, capability coverage, and one returned tradeoff}}

### 👥 Team

| Role | Assignment |
|---|---|
{{one row per selected feasible plan.response_team item containing only its returned role and returned assignment}}

### 🛡️ Safety

**Do now:** {{all incident_policy.immediate_controls items, closely shortened into one sentence or semicolon-separated line}}

**Escalate if:** {{all incident_policy.escalation_conditions items, closely shortened into one sentence or semicolon-separated line}}

_Status: proposed only — verify on scene; no associate was dispatched and no external action ran._
```

## Unavailable assessment

```markdown
# ⚠️ Store incident response unavailable

**Reported error:** {{exact helper error without credentials, endpoint details, or image path}}

No associate plan was inferred from memory or general staffing assumptions. Use the store's on-scene safety and emergency procedures for any immediate risk.
```
