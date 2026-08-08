# Drive-In Auto Scheduler

`sonic-scheduler.html` — a single-file weekly crew scheduler for a drive-in.
Open it in a browser. No install, no server, no network. Everything is saved to
your browser's local storage, and the whole setup exports to a JSON file you can
carry between machines.

The output prints in the Expressway weekly-schedule layout: crew rows grouped by
position, one column per day, shift times as `10:00A-6:00P`, weekly hours and
labor dollars on the right, and daily hours / projected sales / labor % totals
across the bottom.

## Using it

1. **Store & Budget** — store number, week start, labor budget %, SPLH target,
   store hours and projected sales per day. Also the shift rules: min/max shift
   length, max days per person, overtime threshold, minimum rest between shifts,
   and unpaid break.
2. **Crew** — one card per person: position, second position they're trained on,
   capability rating, wage, min/max hours, and a seven-day availability strip.
   Uncheck a day to log requested time off.
3. **Sales Forecast** — the estimated income per hour, every cell editable. It's
   generated from each day's total against a demand curve (lunch peak, 2–4pm
   drink rush, dinner), and you can type over any hour you know better.
4. **Generate schedule** — then print, export CSV, or copy into a spreadsheet.
5. **Diagnostics** — what the schedule couldn't satisfy and why.

Press **Load sample crew** for a 20-person roster with conflicts and time-off
already filled in.

## How it decides

**Demand.** Hourly sales ÷ SPLH = crew hours needed that hour, floored at your
minimum crew. That splits into one manager (two once the hour gets busy enough),
then the back-of-house share to cooks and the rest to carhops.

**Capability.** A rating isn't just a tiebreaker — it's how much coverage the
person actually provides. A 1 counts as 0.72 of a crew slot, a 3 as 1.00, a 5 as
1.28. So a shift of strong people covers the same demand with fewer bodies.
Manager *presence* is the exception: that's counted as headcount, because a
new manager still holds the keys.

**Assignment**, in four passes:

1. **Manager spine.** Nobody else gets scheduled first. Days are ordered by how
   few managers are available — a day with one available manager gets first
   claim on that manager's week — and each day is walked open to close, always
   filling the earliest hole. That ordering matters: a naive "best value" greedy
   picks a fat midday shift, splits the day into two edges, and leaves Saturday
   night with nobody to close.
2. **Crew coverage.** Repeatedly takes the shift that buys the most unmet demand
   per labor dollar, weighted by position priority and capability, discounted for
   working a secondary position, for pushing someone into overtime, and for
   putting a conflicting pair on the floor together.
3. **Minimum hours.** Brings anyone still under their guaranteed hours up.
4. **Budget trim.** While over budget, shaves half-hours off the ends of shifts
   where coverage is in surplus. It won't trim manager coverage, won't cut a
   shift below the minimum length, and won't cut into hours the forecast still
   needs.

**Hard rules**, never violated: requested time off, availability windows, min and
max shift length, max hours, max days, minimum rest between shifts, one shift per
person per day, only positions the person is trained for, and "never overlap"
pairs. Anything that can't be satisfied comes out as an unfilled hole and gets
reported rather than being quietly papered over.

**Soft rules**, discouraged but allowed when demand requires: "avoid overlapping"
pairs, overtime, and secondary positions. Every one that ends up violated is
listed in Diagnostics.

**Precedence** when it can't have everything: manager coverage beats crew
coverage, hard rules beat the budget, guaranteed minimum hours beat the budget,
and the budget beats full coverage. The budget is held across the week, not day
by day — individual days run over and under.

## Reading the diagnostics

The useful distinction is *why* you're short:

- **Capacity-limited** — budget left over but no one available to spend it on.
  Open up availability, raise someone's max hours, or add crew.
- **Budget-limited** — covering the forecast would push past the labor budget.
  Raise the budget or raise the SPLH target so it demands less crew.

The coverage grid shows scheduled crew over required crew for every half hour:
red is short, amber thin, green covered, blue overstaffed.

## A note on the format

The layout is the standard weekly-schedule report — position groupings, day
columns, hours and labor totals, labor % footer. I built it from that convention
rather than from the real Expressway screen, which isn't publicly reachable. If
the column headers, ordering, or footer labels need to match your store's
printout exactly, send a screenshot and it's a small change — the entire
printout is generated in `renderPrintout()`.
