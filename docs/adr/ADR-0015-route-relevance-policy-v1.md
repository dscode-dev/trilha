# ADR-0015 — Route relevance policy v1

**Status:** Accepted (PR-04, 2026-09-05)

## Context

Discovery produces more candidates than a person will read. Something has to order
them, and that something is making a claim on Trilha's behalf about what is worth a
traveller's time.

Two constraints shape what that claim may be.

**The first is what Trilha actually knows.** There are no ratings, no reviews, no
votes, no visit counts and no user history in the product. Every signal available is
geometric or temporal: how far off the line, how much longer the trip, where along the
journey. A ranking that implied more than that — "top rated", "popular", "recommended
for you" — would be fabricating the evidence for its own output.

**The second is that the formula will change.** Ratings arrive in a later PR, safety
after that. A score computed today must not be silently compared against one computed
next quarter under different weights.

## Decision

**A deterministic, explicit, versioned scoring function.** No model, no learned
weights, no embeddings (§86). A ranking a user disagrees with should be one an
engineer can explain line by line.

```
score = 0.60 · detourEfficiency
      + 0.25 · proximity
      + 0.15 · placement

detourEfficiency = 1 − clamp(detourSeconds     / maxDetourSeconds,  0, 1)
proximity        = 1 − clamp(distanceFromRoute / corridorWidth,     0, 1)
placement        =     clamp(min(p, 1 − p)     / 0.15,              0, 1)
```

Range `[0, 1]`, four decimal places. The weights sum to 1, so the bound is a property
of the construction rather than a clamp at the end — a future component cannot push
results past 1 without someone noticing the weights no longer sum.

**Detour dominates at 0.60**, because it is the only term measured in the unit the
traveller actually spends. It is also the term that resolves the case the whole feature
exists for: a Place 2 km off the line but 25 minutes away scores below one 4 km off and
7 minutes away, which straight-line proximity gets backwards.

**Proximity is secondary at 0.25** and stays there. Before detour existed it was the
only signal; now that real road cost is measured, straight-line closeness is a weak
proxy that must not override the strong one.

**Placement at 0.15 only avoids the ends.** The ramp reaches full value at 15% of the
journey and is *flat across the entire middle*, so a Place at 25% scores identically to
one at 50% — nothing is nudged toward the centre for its own sake. What it does penalise
is a Place 2% along the route, which is where the traveller is leaving from rather than
something found along the way (§31).

**Both endpoints of the request are context, not constants.** The same ten-minute
detour is most of a fifteen-minute budget and a rounding error in a two-hour one, so
`maxDetourSeconds` normalises the detour term; `corridorWidthMeters` normalises
proximity the same way.

### What is deliberately absent

**Provenance contributes nothing.** It records where a Place came from, not whether it
is any good. Giving `SYSTEM` a bonus would quietly demote everything the community
contributed, in a feature named for the community (§32).

**Data completeness contributes nothing.** A description is text, not quality. Weighting
it would rank a verbose entry above a better-placed one and call that a judgement about
the place (§33). §33 permits a small component here; measured against what it would buy,
it does not earn its place, so it is not in the formula.

**Category contributes nothing.** Trilha has no basis for saying a viewpoint beats a
restaurant. The user says that, with the filter.

### Explanation is part of the output

Every candidate carries reason codes — `ON_ROUTE`, `LOW_DETOUR`,
`GOOD_ROUTE_POSITION`, and so on — computed from the same signals as the score. Codes,
never sentences: the backend has no business deciding how a Brazilian traveller reads
"+7 minutes", and a provider's own phrasing must never reach a screen (§34, §35). The
client owns the wording; the contract owns the vocabulary.

**The score itself is never shown.** "+7 min" is a fact a traveller can act on;
`0.91423` is an implementation detail that invites comparisons across policy versions
that are not comparable (§59).

### Versioned, and named in every response

`policyVersion: "v1"` ships with the results. When v2 lands, a support conversation
about "why was this ranked first" has an answer, and two rankings from different
versions are visibly not the same measurement (§36).

The weights live in code, not configuration (§84). Environment-tunable weights would
let two deployments rank the same route differently with nothing in the response to
explain it — the version would be a lie.

### Ordering is fully determined

```
score DESC, detourDurationSeconds ASC, placeId ASC
```

Two candidates with equal scores must come back in the same order on every request, or
a user who changes a filter sees the list shuffle for reasons they cannot perceive.
`placeId` is the final tie-break because it is the only value guaranteed unique and
stable.

## Alternatives

- **Learned ranking.** Rejected, and not only by §86: there is no training signal.
  Nobody has told Trilha which suggestions were good.
- **Detour alone.** Rejected: it ignores that a place can be cheap to reach and still
  be at the very start of the journey, or far enough off-route to feel like a
  different trip.
- **A hard detour threshold with no scoring.** Rejected: a ceiling already exists as a
  *filter*; within the surviving set the ordering still has to mean something.
- **Weights in configuration.** Rejected — see above.
- **Showing the score.** Rejected: it is not a quality rating, and rendering a number
  is how it becomes read as one.

## Consequences

- The ranking is testable as *properties* rather than memorised numbers: monotonic in
  detour, bounded on a swept input space, identical for identical inputs, stable under
  shuffling. A weight change breaks a property test only when it changes the behaviour
  the property describes.
- `RelevanceSignals` is an interface, so PR-06 can add `rating` and `reviewCount` as a
  v2 policy without rewriting the pipeline (§88). No placeholder field exists for them
  now — an empty column is an invitation to fill it with something fabricated.
- A score is comparable only within one policy version, and the response says which.
