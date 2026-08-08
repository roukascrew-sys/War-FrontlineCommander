# Drive-In Auto Scheduler

`sonic-scheduler.html` — a single-file weekly crew scheduler. Open it in a
browser. No install, no server, no network. Everything saves to your browser's
local storage, and the whole setup exports to a file you can carry between
machines.

Two jobs:

- **Next week** — builds three ranked schedule options from your numbers and
  prints the chosen one in the Expressway weekly-schedule layout.
- **This week** — as things come up, suggests the smallest change that covers
  the hole, and records it as an amendment.

## Using it

1. **Store & Budget** — store number, week start, and the **daily labor budget
   in dollars** (or a percent of sales if that's how you're given it). Budget is
   enforced day by day, never averaged across the week.
2. **Crew** — position, second position they're trained on, employment type,
   capability, wage, min/target/max hours, seven-day availability, requested
   time off, and pairing notes.
3. **Sales Forecast** — estimated income per hour, every cell editable.
4. **Build 3 options** — pick one, then print, export CSV, or copy to a spreadsheet.
5. **Modify schedule** — live changes once the week is underway.

**Load sample crew** fills in a 21-person roster with pairings, minors and
part-timers already set up.

## Hours people actually want

Everyone has three numbers, and **target** is the one that drives the schedule:

- **Min** — hours you've guaranteed them. Honored ahead of the budget.
- **Target** — what they want in a normal week. The scheduler aims here.
  Going past it makes a shift progressively less attractive, so hours spread to
  people who want them instead of piling onto whoever is most convenient.
- **Max** — a hard ceiling, never crossed.

Part-timers, students and full-timers are all first-class: nobody is assumed to
want 40. The printout carries a **TGT** column next to actual hours so you can
see at a glance who came up short or ran long, and Diagnostics names anyone more
than four hours off.

## The rules

**Hard — never violated.** Requested time off, availability windows, min and max
shift length, max hours per day, max hours per week, max days per week, max days
in a row, minimum rest between shifts, one shift per person per day, only
positions the person is trained for, "never overlap" pairs, and — when the
no-overtime switch is on — the overtime threshold.

**Minor / student rules.** Anyone marked *Minor* gets a shorter daily cap, a
school-night curfew, and their own weekly day limit. You choose which nights
count as school nights.

**Soft — discouraged, allowed when the day demands it.** "Avoid overlapping"
pairs, overtime (when permitted), working a secondary position, and
inconsistent start times. Every one that ends up bent is listed in Diagnostics.

**Pairing.** Four kinds, set per person on their card:

| Pairing | Effect |
|---|---|
| Works well together | Actively tries to overlap them, and counts their output slightly higher |
| Less efficient together | Avoids overlapping; when they do overlap, counts their combined coverage lower, so the day gets staffed a little heavier |
| Avoid overlapping | Strongly discouraged, but possible when nothing else covers |
| Never overlap | Hard rule |

**Precedence when it can't have everything:** manager coverage first, then hard
rules, then guaranteed minimum hours, then the daily budget, then full coverage.

## How it builds a schedule

**Demand.** Hourly sales ÷ SPLH = crew hours needed that hour, floored at your
minimum crew, split into a manager (two once the hour is busy enough), then the
back-of-house share to cooks and the rest to carhops.

**Capability drives coverage, not just ordering.** A 1 counts as 0.72 of a crew
slot, a 3 as 1.00, a 5 as 1.28, so a strong shift covers the same demand with
fewer bodies. Manager *presence* is the exception — counted as headcount,
because a new manager still holds the keys.

**Four passes.** The manager spine goes down first: days ordered by which have
the fewest managers available, each walked open to close filling the earliest
hole. (A plain best-value greedy takes a fat midday shift and strands both edges
of the day — that was a real bug, and this ordering is the fix.) Then crew
coverage by unmet demand per labor dollar, then minimum-hour guarantees, then a
trim pass that shaves surplus half-hours to land under each day's budget.

## The three options

The same data is run three times with different priorities, then ranked on
coverage held, manager holes, overtime created, days over budget, how many
people land near their target hours, and budget left unspent on days that are
short. First card is the recommendation; the other two are real alternatives,
not decoration.

- **Balanced** — even handling of coverage, cost and target hours.
- **Cost-lean** — leaves margin under every daily budget; thinner at peak.
- **Coverage-first** — spends the full budget on your strongest crew to hold the
  peaks; runs closer to the line.

Which one ranks first depends on your numbers, not on a fixed order.

## Modifying the schedule live

Set today's date, then say what came up: someone can't work, someone goes home
early, you need extra coverage, or you need to cut dollars from a day.

Suggestions come back in the order a manager would actually work through them:

1. **Call in someone who wants hours** — anyone under their target first,
   because those are hours they've asked for.
2. **Extend someone already on the floor** — managers and high-capability crew
   first. Nobody's day gets rearranged.
3. **Move a posted shift** — last resort, and only ever a suggestion.
4. **Leave it** — with the exact labor and coverage consequence spelled out.

Every option shows what it costs, where it leaves that day against budget, and
any rule it would bend.

**The posted schedule is treated as set in stone.**

- Days before today are locked outright.
- A shift cannot be moved on someone with **less than two days' notice** — those
  options are shown, marked *not allowed*, and cannot be applied.
- Even with notice, a move is labeled *suggestion only* and needs the
  employee's agreement. People plan around posted shifts.
- Calling someone in or asking them to stay is an *ask*, not a change, so it's
  available at any notice.

Applying a suggestion records an **amendment** — the original shift stays
visible on the printout, struck through, with the change listed in an
amendments block at the bottom. Amendments are individually undoable. Building a
fresh set of options clears them.

## Reading the diagnostics

The useful distinction is *why* you're short:

- **Capacity-limited** — budget left over but nobody available to spend it on.
  Open availability, raise a max, or add crew.
- **Budget-limited** — covering the forecast costs more than the day allows.
- **Below the floor** — one manager open-to-close plus your minimum crew already
  costs more than the day's budget. No legal schedule fits; the budget, the store
  hours or the minimum crew has to give. It says so by name and by dollar.

The coverage grid shows scheduled crew over required for every half hour: red is
short, amber thin, green covered, teal overstaffed.

## Testing

Verified in Chromium against an independent audit that re-checks every hard rule
on the generated output — 22 scenarios including impossible budgets, everyone a
minor, a 19:00 curfew, all-pairs-never-together, no managers, a 24-hour
operation, zero sales, and everyone wanting 8 hours. No violations, no page
errors. Every button is checked for a handler and exercised with browser dialogs
**blocked**, since the hosted copy runs in a sandbox where `confirm()` silently
returns false — the original cause of "Clear all does nothing."

## A note on the format

The layout is the standard weekly-schedule report — position groupings, day
columns, hours and labor totals, budget and variance rows. I built it from that
convention rather than the real Expressway screen, which isn't publicly
reachable, so I can't claim column-for-column fidelity. Send a screenshot of
your printout and matching it is a small change — it's all generated in
`renderPrintout()`.
