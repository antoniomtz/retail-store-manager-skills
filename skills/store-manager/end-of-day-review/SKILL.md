---
name: end-of-day-review
description: Analyze one completed independent synthetic retail store day and prepare an evidence-based end-of-day operating review with sales performance, checkout response, OPD execution, workforce call-outs, inventory stockouts, bounded estimated revenue at risk, and ranked next-day priorities. Use when a Store Manager asks how the day went, requests the daily close or end-of-day report, asks about today's operational losses or missed opportunity across the store, wants lessons from today's incidents, or asks what to prioritize tomorrow. Do not use for a current checkout or OPD incident; use their operating skills instead.
---

# End-of-Day Review

Use only the packaged helper at
`__HERMES_HOME__/skills/store-manager/end-of-day-review/scripts/fetch_end_of_day_review.py`.
It reads the completed independent eight-hour simulation through one bounded,
read-only Camel endpoint. It is the sole source of store-day facts, estimates,
and tomorrow context for this workflow. Never substitute conversation history,
a morning briefing, another operating simulation, or OpenViking memory.

## Workflow

1. Use the configured store and demo business date when the manager omits
   them. Do not ask for either value and do not substitute the host UTC date.
2. If the manager explicitly supplies a store ID, require
   `[A-Za-z0-9_-]{1,64}`. If the manager supplies a date, require `YYYY-MM-DD`.
   The helper rejects a value outside this deployment's assignment.
3. Run the helper exactly once through the terminal tool using this stable
   path. Never use a Relay temporary skill directory, `curl`, a browser, or a
   different endpoint:

   ```bash
   python3 "__HERMES_HOME__/skills/store-manager/end-of-day-review/scripts/fetch_end_of_day_review.py"
   ```

   Add only a validated `--store-id STORE_ID` or
   `--business-date YYYY-MM-DD` explicitly supplied by the manager.
4. Confirm the returned identity, `simulation_status: completed`, 480-minute
   period, complete sample count, `data_quality.status: complete`, and
   `agent_assisted_impact.status: simulated_attributed`. Stop if any check
   fails.
5. Read [the review contract](references/end-of-day-review-contract.md) before
   interpreting estimates, cross-signal evidence, or an unfamiliar field.
6. Load the required format with this exact tool call:

   ```text
   skill_view(name="end-of-day-review", file_path="references/telegram-rich-message-templates.md")
   ```

   Do not compose the response until that supporting file has loaded. Render
   the completed review from the current helper response only.

## Analysis rules

- Produce an executive close, not a comprehensive operating report. Lead with
  one sentence that connects the strongest completed interventions to their
  observed sales, customer-experience, or productivity results. Do not repeat
  that sentence as another introductory paragraph or place an estimated
  no-action comparison in the lead.
- Organize the action table around what the store did and what changed: opening
  checkout capacity, moving online-order coverage, and offering available
  alternatives. Rewrite each completed action in concise past tense, use one
  row per action, and pair it with its observed result.
- State total net sales against the daily sales goal under `What needs
  attention`. Keep completed alternative-product purchases in the action table
  and do not use that narrower result as the store's total-sales headline.
- Use returned summary metrics for all counts, durations, rates, ranges, and
  financial values. The timeline may confirm when a pattern occurred or supply
  the returned closing sample; do not recalculate a different summary.
- Distinguish direct observations from estimates. Describe
  `estimated_opportunity_cost` only as **estimated revenue at risk**, preserve
  its low and high values, and state its returned assumptions.
- Never add estimated opportunity cost to observed sales variance. The
  measures can overlap.
- Treat unserved product requests as an observed demand signal, not confirmed
  abandoned sales.
- Use incident timestamps—not 15-minute samples—to state how long it took to
  open checkout capacity, begin OPD recovery, or cover a call-out.
- Call a cross-signal relationship a contributing factor or planning risk
  unless the returned source explicitly establishes causation.
- Credit an intervention as successful only when its returned outcome or
  checkpoint says it recovered or met its target.
- Describe the inventory intervention from its evidence records: state the
  number of alternative offers, the number that resulted in completed
  purchases, the offer-to-purchase rate, and the sales from those purchases.
  Never describe offers or transactions as unique customers. Keep those sales
  separate from total sales, where they are already included.
- Use observed before-and-after values for checkout wait and online-order pick
  rate. Put the no-action comparison on one separate line labeled `Estimated
  impact avoided`. Never blend observed and estimated values.
- Write the completed review exactly as a production Store Manager update. Do
  not mention Hermes, Camel, an agent, a simulator, a simulation, synthetic or
  demo data, fixtures, receipt IDs, implementation provenance, or technical
  evidence linkage. Those details remain available in the internal contract
  and source data, not in the manager-facing response.
- Omit hourly sales, full incident histories, complete inventory lists,
  assumption tables, evidence timestamps, and secondary operating metrics from
  the default response. Use them only to select and support the concise facts.
- Use plain retail language. Write `above plan` or `below plan`, never `to
  plan`. Say `online orders`, not `OPD`; `alternative product`, not
  `substitute`; and `requests for products that were out of stock`, not
  `unserved product requests`. Put one business idea in each sentence; do not
  join three negative results with `while`.

## Tomorrow priorities

Propose exactly two ranked next-day priorities. Keep each to one concise
sentence. Each priority must:

1. name a clear action and timing;
2. cite the strongest one or two returned facts;
3. explain the expected operational benefit without inventing a numeric
   outcome;
4. identify a manager or operational role only when the response supports it;
5. disclose a tradeoff only when it materially changes the choice; and
6. remain explicitly proposed rather than completed.

Prefer actions that address tomorrow's returned demand, weather, promotion,
inbound inventory, and opening coverage while incorporating lessons from
today's measured incidents. Do not recommend changing prices, promotions,
orders, staffing, or inventory records unless the returned evidence supports
manager review of that proposal.

For a staffing priority, take the department, time window, and coverage gap
from the same `tomorrow_context.opening_workforce` record. Never combine a role
from today's call-out with a different department's gap tomorrow. For inbound
inventory, do not recommend receiving or staging an item before its returned
arrival time; say to act when it arrives. Refer to a promotion by its returned
name or plain-language description, never by a department label.

## Response format

Use the Completed end-of-day review rich-message template. Preserve its
plain-language headings, semantic emojis, compact action-to-result table, and
estimate label. Keep the completed response under 220 words. Do not add
provenance or status boilerplate, sections, full incident inventories,
`<details>` blocks, placeholder braces, or code fences.

If the helper says the simulation has not run, use the Simulation not ready
template and provide only its repository-host command. Do not run the host-only
simulator from Hermes. For another helper or data error, use the Unavailable
review template and do not present a partial result.

## Boundaries

This skill is read-only. It may report completed historical synthetic actions
only when their recommendation, approval, action receipt, and impact appear in
`agent_assisted_impact`. It must not configure a cron job, create a webhook,
call the host-only simulator, execute a new task, change staffing, open a
checkout, change inventory, alter a promotion, expose an endpoint or
credential, or claim that this review executed an action.
