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

## Humane hours

The scheduler will not hand anyone a shift it would be unreasonable to work:

- **Max hours per day** (default 8) — separate from max shift length, so a long
  day can't be assembled out of parts.
- **Minimum rest between shifts** (default 10h).
- **No close-then-open turnarounds.** A plain rest check passes a midnight close
  followed by a 10am open; that is still brutal, so a closing shift gets its own
  longer gap before the next shift (default 12h). On by default.
- **Cap on closing shifts per person** (default 4), so the same person isn't
  closing every night.
- **Max days in a row** (default 5) and max days per week (default 6).
- **Fairness** is scored, not just hoped for: options are ranked partly on how
  evenly people land against the hours they asked for, and Diagnostics flags the
  spread when it drifts.

The Store & Budget tab warns you when the *limits themselves* are the problem —
a 13-hour daily cap, a 6-hour rest gap, seven days in a row, or turnarounds
switched off.

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

**Cross-trained pay.** Anyone with a second position can carry a second rate,
and every shift is costed at the rate for the job actually worked — a carhop who
cooks that night is paid the cook rate, and the printout shows both rates. Leave
the second rate blank and it uses their normal one (a manager covering a cook
shift keeps manager pay).

**Personal commitments.** Each person can list things they need time for — a
graduation, a night class, a tournament. *Keep free if possible* is a strong
preference the scheduler works around; *cannot work then* is a hard rule. Both
are checked in Diagnostics.

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

## Store events

Anything that changes how busy an hour is: half-price drinks 2–4, corn dog
Tuesday, a Friday night rush, a slow holiday. Each event names its days, its
hours and a percent effect — positive for busier, negative for slower — and the
hourly forecast, the crew it calls for, and the percent-of-sales budget all move
with it. **Add common ones** drops in the usual suspects to edit.

Affected cells are shaded on the forecast grid, and the Store & Budget tab shows
each day's base sales beside its with-events total.

## Working from a past week

Give it a week that worked and it will keep people on the same days and start
times wherever the rules, availability and budget still allow — people like
knowing roughly when they work. A slider sets how closely to follow it, from a
nudge to sticking close.

Three ways to get one in:

- **Save current schedule** — one click, once you've built a week you like.
- **Enter a past week** — a grid you type into. Times are read loosely:
  `10a-6p`, `10-6`, `1030-1830`, `10:30a-6:30p`, or blank for a day off. Entries
  it can't read are outlined in red as you type rather than silently dropped.
- **From a photo** — take a picture of a posted schedule with the device camera,
  or pick an image file. The picture is pinned above the same grid so you can
  type straight off it.

**About the photo option:** nothing is read off the image automatically. The app
runs entirely offline with no network access, so there is no text recognition
available to it — the photo is there to type from, not to import. Templates made
this way are labeled **"From a photo — verify"** everywhere they appear, the
label follows them into Diagnostics when used, and selecting one warns you to
check the shifts before posting. An exported file is always the more reliable
route.

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

With a template loaded, **Like your template** replaces Balanced as the fresh
read — following last week is what you actually want as the default once you
have given it a model.

Which one ranks first depends on your numbers, not on a fixed order. Ranking
also accounts for fairness, close-then-open turnarounds and over-long days.

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

Verified in Chromium against an independent audit that re-derives every hard
rule from the generated output — weekly and daily hour caps, consecutive days,
rest gaps, close-then-open turnarounds, closing-shift caps, minor curfews and
day limits, never-together pairs, must-keep commitments, positions the person is
trained for, and that every shift is costed at the rate for the position worked.

22 scenarios, all passing, including impossible budgets, everyone a minor, a
19:00 curfew, all-pairs-never-together, no managers, a 24-hour operation, zero
sales, and everyone wanting 8 hours. No page errors.

Every button is checked for a handler and exercised with browser dialogs
**blocked**, since the hosted copy runs in a sandbox where `confirm()` silently
returns false — the original cause of "Clear all does nothing."

The template is tested against a deliberately *different* template (every start
pushed two hours later): at weight 0 it changes nothing, at full weight it moves
73% of shifts and follows the template wherever availability allows. Testing it
against a template built from its own output would have proved nothing, since
the solver is deterministic.

Building three options takes roughly five seconds. Progress is shown as
"Building 2 of 3…", and the page yields between options so it never looks frozen
on slower hardware.

## A note on the format

The layout is the standard weekly-schedule report — position groupings, day
columns, hours and labor totals, budget and variance rows. I built it from that
convention rather than the real Expressway screen, which isn't publicly
reachable, so I can't claim column-for-column fidelity. Send a screenshot of
your printout and matching it is a small change — it's all generated in
`renderPrintout()`.
