# Showcase the roster on /artists

**Status:** proposed, awaiting approval
**Issue:** #1098
**Supersedes:** the artist-discovery design of 2026-09-03, which proposed a facet
rail and was rejected as redundant. That rejection is the starting point here.

## The correction this spec is built on

The first attempt proposed filtering `/artists` by Sound, From and History. The
owner's response was that it is _"truly redundant"_, and it is. Look at what the
page already prints for every artist:

```text
Adelleda
Punk · Hamilton, ON
1 show
```

Genre, city and show count are on every row, above a search field and an A-Z
index. A facet rail would let a fan narrow by the exact three things the page has
already told them. It adds a control surface and reveals nothing.

The ask was never _"help me narrow 227 down"_. It was, in the owner's words,
**"creative ways to showcase all the artists"**. Showcase, not filter. That is a
different problem, and the earlier spec solved the wrong one.

## The number that should drive the design

| Signal                                            | Value                |
| ------------------------------------------------- | -------------------- |
| **Artists whose page has never been viewed once** | **116 of 227 (51%)** |
| Artists with 1-9 views                            | 100                  |
| Artists with 10+ views                            | 11 (most-viewed: 45) |

**Half the roster has never been looked at.** Not "rarely" -- never. That is the
problem worth solving, and it reframes every feature below: the job is not to
help someone find a band they already have in mind, it is to put the other 116
in front of anyone at all.

It also settles the shuffle's weighting on its own. An unweighted random draw
re-surfaces whatever is already visible; weighting toward the unseen is the only
version that changes that number.

## What the data will and will not support

Measured against production on 2026-09-04.

| Field                                | Coverage             | Consequence                                    |
| ------------------------------------ | -------------------- | ---------------------------------------------- |
| `origin_city`                        | **181 / 227 (80%)**  | Best-covered field. 73 are Waterloo Region.    |
| Bandcamp link                        | **183 / 227 (81%)**  | Discovery can end in _hearing_ something.      |
| `genre`                              | 164 / 227 (72%)      | 66 tags, **42 of them on exactly one artist**. |
| `description` (bio)                  | 75 / 227 (33%)       | Too thin to carry a layout.                    |
| `photo_url`                          | **26 / 227 (11%)**   | **Any photo grid renders as placeholders.**    |
| Performances linked to a profile     | **298 / 298 (100%)** | The co-performance graph has no holes.         |
| Co-performance pairs                 | **4,730**            |                                                |
| Artists with at least one stage-mate | **227 / 227**        | "Shared a bill" can never render empty.        |
| Artists with more than one edition   | 46                   | "Returning" is real and populated.             |

Three of these are load-bearing:

**Photos are 11%, and band photos are a deprioritised backlog item.** So the
surface must be typographic. That is a constraint, not a compromise: 227 names
set well scan better on a phone than 227 cards, most of which would be initials.

**Every performance resolves to a profile, and every artist has a stage-mate.**
That is what makes "shared a bill with" trustworthy _and_ universal -- no artist
gets an empty section, and a fan cannot mistake a missing edge for a real one.

**42 of 66 genre tags belong to a single artist.** The tail is the catalogue:
Frog Funk, Desert Rock, Art Folk, Comedy Rock, Drag. It is the most interesting
thing in the data and the least suited to a filter.

## The design

Four pieces, ordered by how much they move the 116.

### 1. Shuffle five

A button drawing five artists, weighted toward the never-seen.

**The contract, stated precisely** — an earlier draft said "draw from the 116
never-viewed first, then the 1-9 bucket, then anyone" AND "not a hard
partition", which are opposite instructions. An implementer had to guess. The
rule is a weighted draw, not staged selection:

- Weight each active artist by view count: `total_views = 0` -> weight 6,
  `1..9` -> weight 3, `10+` -> weight 1.
- Draw `limit` artists **without replacement**, so five results are five
  distinct artists.
- No bucket is a gate. A well-known act can appear; it is simply six times less
  likely than an unseen one. That is what stops the feature reading as a
  remainder bin while still moving the 116.
- If fewer than `limit` artists are eligible, return what exists. Do not pad,
  and do not repeat.
- `total_views` is read live from `band_profiles`; there is no snapshot to go
  stale.

**Eligibility is the public roster's, not a new rule.** `/api/artists` already
excludes artists attached only to draft events. These routes reuse that gate via
`publicEventStatusSql()` rather than restating it, so an unannounced lineup
cannot leak through a discovery endpoint. Each route tests the draft-exclusion
case.

**Not cached.** `CACHE_BROWSE` is `public, max-age=300` and the URL never
changes, so a browser would serve the same five artists for five minutes: a
shuffle that does not shuffle. The response is `no-store`. Not a shorter
max-age -- any non-zero window is a window in which the button does nothing.
The other two routes are stable aggregates and correctly keep the tier.

**Listen links reuse the existing contract**, they do not define a second one.
`functions/api/artists.js` sanitises through `normalizeHttpUrl`; `ArtistsPage`
applies `safeExternalHref`, prefers Bandcamp over Spotify, and renders nothing
for a value resolving to `#`. The shuffle result carries the same resolved link
under the same priority, and omits the anchor entirely when nothing resolves.

### 2. One of one

The 42 single-artist genres, surfaced as an invitation rather than a filter:

> **One of one** — exactly one artist here plays Frog Funk.

A tag with n=1 and a tag with n=25 do different jobs. `Punk (25)` is a browse
axis nobody needs; `Frog Funk (1)` is a reason to click. This costs one query
and turns the least filterable part of the data into the most interesting.

### 3. Shared a bill

On an artist's page: who they have played with, from the 4,730-pair graph.

A **fact about the bills**, never an inferred similarity score. That distinction
is the whole reason it is trustworthy, and it is why no taste modelling appears
in this spec.

### 4. Artists can correct their own page

On the individual artist profile (`/band/<slug>`) -- the page an artist lands on
when they look themselves up, and the only one where they can see what we got
wrong. Approved wording:

> **Is this your band?** Tell us if anything is wrong - genre, hometown, links.

Links to `/contact?artist=<band_profiles.id>`, which already has a "Corrections
& takedowns" section, so the language matches where it sends them.

**The id handoff is concrete, not implied.** `/contact` reads the `artist`
query parameter, resolves it to a name, and shows which profile the correction
is about ("Correcting: BA Johnston") so the sender can see they are on the right
record. It travels with the submission, so a report arrives attached to a row
rather than needing a follow-up to establish who it is about. An absent or
unresolvable `artist` renders the ordinary contact page -- the parameter adds
context, it never gates the form.

Three deliberate properties:

- **It self-selects in three words.** Most readers of an artist page are fans.
  "Is this your band?" lets everyone else skip it, which is what keeps it quiet
  rather than clutter.
- **It names what is fixable.** A vague "let us know" gets nothing. Naming genre,
  hometown and links steers reports at the three actual gaps -- 62 artists with
  no genre, 46 with no city, and the dead links the href resolver silently drops
  -- which are the same fields piece 5 is about to make visible.
- **It promises no turnaround.** No "we will update within 48 hours". One person
  runs this.

Cheap insurance, not a data strategy: it costs one line and occasionally catches
something only the band could know.

**No automated release-data feature ships** -- see piece 6, where every source
was evaluated and none is usable. If an artist volunteers a release through this
line, it is published under the submission terms set out there; nothing fetches
it, and nothing sorts on it.

### 5. Show what an artist is ON, and let a fan slice by it

The roster prints genre, city and show count. It prints **nothing** about where
you can hear or follow an artist -- you have to open each profile to find out.
That is why this is not the facet rail: it reveals something the page has never
said.

Coverage across all eight link fields, measured 2026-09-04:

| field       | artists |     |
| ----------- | ------- | --- |
| bandcamp    | 183     | 81% |
| instagram   | 155     | 68% |
| facebook    | 142     | 63% |
| website     | 138     | 61% |
| apple_music | 107     | 47% |
| spotify     | 105     | 46% |
| linktree    | 97      | 43% |
| youtube     | 93      | 41% |

**Nothing here is rare**, so no single platform is a strong _narrowing_ tool --
the range is 41% to 81%. The value is the other direction: a fan who lives in
one platform can see their half of the roster, and everyone else can finally
tell from the list whether there is anything to listen to.

So both halves ship together, and the first matters more:

- **On the row:** the artist's links, as the compact icon set the admin roster
  already uses. This is the piece that closes the gap.
- **Above the list:** a toggle per platform, each showing its count, so picking
  one is an informed choice rather than a guess. Multi-select, AND-combined.

#### The constraint that decides correctness

**Presence must be resolved, never inferred from the stored value.** A link is
present only if it resolves to a real href -- `resolveHref(value) !== '#'` --
because `safeSocialProfileHref` rejects any handle containing whitespace or a
colon, so a value can be non-empty in D1 and render nothing.

Counting `social_links LIKE '%"bandcamp"%'` would therefore claim an artist "has
Bandcamp" while their row shows no icon. That is exactly the bug #712 fixed, and
CLAUDE.md names it: anything asking "does this artist have Instagram?" goes
through `hasField()` / `hasAnyLink()` / `countLinks()` in
`frontend/src/admin/utils/bandFields.js`, never at `social_links` directly.

**The counts in the table above are key-presence counts and are therefore an
upper bound.** The real numbers must be computed through the resolver, and the
implementation must not reuse those figures.

The server-side companion is `BAND_LINK_FIELD_KEYS` in
`functions/utils/bandLinkFields.js`. Adding a ninth platform means both homes
plus `sanitizeBandSocialLinks`; do not introduce a third list here.

### 6. Recent releases — investigated and NOT adopted

The owner's original idea included "recent bandcamp releases", later sharpened
to sorting and filtering the roster by release recency. Every route was
evaluated. None works, and the reasons differ.

**Conclusion up front: no release-data feature ships.** No fetching, no storage,
no sort, no filter, no migration, no scheduled job. Nothing elsewhere in this
document should be read as deferring to a later release feature.

| Source                             | Verdict                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scrape Bandcamp (`bandcamp-fetch`) | **Prohibited.** The Acceptable Use and Content Moderation Policy, incorporated into the Terms of Use, forbids scraping "through the use of scripts, robots, bots, spiders, scrapers, crawlers, or other automated means" and "any form of text and/or data mining".                                            |
| Bandcamp official API              | Account, Sales Report and Merch Orders only, restricted to account holders reading their own data behind an eligibility check. 183 artists would mean 183 OAuth grants.                                                                                                                                        |
| `isitbandcampfriday.com`           | Bandcamp's own site (assets on `s4.bcbits.com`, Bandcamp footer). Same policy.                                                                                                                                                                                                                                 |
| Spotify Web API                    | Fetching is fine. **Storing is not**: "you may not store, aggregate or create compilations or databases of Spotify Content", "Do not store Spotify Content indefinitely", caching "limited to the temporary caching of metadata". Sorting a roster REQUIRES a persistent index, which is the prohibited thing. |
| Apple Music API                    | Requires paid Apple Developer Program membership. Storage terms not verified.                                                                                                                                                                                                                                  |
| MusicBrainz                        | Legal and open, but coverage for small local acts is expected to be poor.                                                                                                                                                                                                                                      |

**The argument that settles it needs none of the above.** Spotify covers 105 of
227 artists (46%); Apple Music 107 (47%). So even with permissive terms and a
paid membership, a "sort by recent release" view ranks **fewer than half the
roster** and silently omits the rest.

That is not a partial feature, it is a misleading one. Absence would read as
"has not released anything" when the truth is "we could not see them" -- and the
artists who vanish are disproportionately the smaller ones with no Spotify or
Apple presence. Which is to say: **the 116 who have never been viewed**, the
exact people this document exists to surface. The feature would point the best
idea in it at the wrong half of the roster.

**What replaces it.** Nothing, directly. What already covers the intent:

- Piece 5's link icons put a Bandcamp link in front of a fan for 183 artists
  (81%) -- linking out is not scraping, and it is what Bandcamp wants.
- The Bandcamp Friday banner (dates entered by the owner, never computed) turns
  those links into the moment they are worth the most.
- Piece 4's contact line is the only channel that could carry release news at
  all -- the artist telling us. It is licensed only to the extent the submission
  terms below make it so, and it feeds no sort, filter or rail.

Revisit only if Bandcamp ships a public catalogue API, or if a single source
ever reaches coverage where absence stops being a lie.

#### The Bandcamp Friday banner: timezone is the whole contract

Bandcamp Friday runs **midnight to midnight Pacific time**, in Bandcamp's own
words on their status page. This site is Toronto-local everywhere else, and
Toronto is three hours ahead. Matching a date-only config value against the
wrong clock is not cosmetic: the banner would appear three hours early and
vanish three hours before the day ends, so the last three hours of the actual
promotion -- the evening, when people are home and buying -- would show nothing.

So the rule, stated once and shared by every consumer:

- Announced dates are stored **date-only** (`YYYY-MM-DD`), exactly as Bandcamp
  publishes them.
- A date matches when the current **`America/Los_Angeles`** calendar date equals
  it. Not `America/Toronto`, not UTC, not the browser's zone.
- The API decides, and the browser renders what it is told. A client comparing
  its own local date would show a different answer to a fan in Vancouver than to
  one in Kitchener, for a promotion that is neither of their local days.

This repo already has this bug class documented: `eventLocalToday()` exists
because `toISOString().slice(0, 10)` flips at 8 PM Eastern and marked events
"Happening Now" the evening before. Same shape, different timezone -- and the
answer is the same, name the zone and put it in one place.

#### Artist-submitted release data: get permission, and mean it

Piece 4's contact line is the only channel that could carry release news at all.
It is licensed only to the extent the terms below make it so -- treating a
submission as publishable data has to be explicit, not assumed from the fact
that someone emailed us.

- The submission form states plainly what happens: we may **store, display and
  update** the title, date and link on their artist page.
- **Takedown is unconditional and needs no reason.** An artist asking for
  something removed gets it removed, and the same contact route serves that
  request. `/contact` already has a "Corrections & takedowns" section, so the
  language is in place.
- We publish what the artist sent us -- a title, a date, a link. We do not
  reproduce cover art or copy from anywhere else, which keeps this clear of the
  content questions that closed every other route.

The asymmetry is deliberate: permission to publish is opt-in and specific,
removal is unconditional. An artist who regrets telling us something should
never have to argue about it.

## Explicitly out of scope

- **A facet rail over genre, city or show count.** That is this spec's founding
  lesson: the page already prints all three on every row. Note the contrast with
  piece 5 -- filtering by link presence is fine precisely because the row has
  never shown it.
- **Taste-based recommendations.** "Shared a bill" is a fact; a similarity score
  is a guess, and a wrong guess about an artist's music is worse than none.
- **AI-written bios.** Standing rule: structured facts are ours to research;
  prose representing an artist is not ours to write.
- **Photo-driven layouts.** 11%.
- **Rewriting anyone's genre in the database.** If tags ever need grouping, do it
  at query time and always render the artist's own words.

## Implementation shape

Deliberately small, so it can be delegated in one pass.

**Backend** — three new public read-only endpoints, plus a field on an existing
one. No migration.

- `GET /api/artists/shuffle?limit=5` — weighted draw per the contract above.
  `no-store`.
- `GET /api/artists/one-of-one` — genres belonging to exactly one artist.
  `CACHE_BROWSE`.
- `GET /api/bands/<id>/stage-mates` — co-performers, most-shared first, keyed
  on the canonical `band_profiles.id`. `CACHE_BROWSE`. The file lives at
  `functions/api/bands/[name]/stage-mates.js`: three sibling routes
  (`follow`, `unfollow`, `confirm-follow`) already bind that directory's param
  as `params.name`, and Pages cannot host `[name]/` and `[id]/` at one level.
  The segment's NAME is therefore `name`; the VALUE callers send is the id.
- `/api/artists` gains RESOLVED link presence per artist.

**The resolved-link response shape, stated exactly.** Every consumer -- row
icons, per-platform counts, the filter, and the shuffle's listen link -- reads
one field, so they cannot disagree about what "has Bandcamp" means:

```json
"links": {
  "bandcamp":  "https://artist.bandcamp.com",
  "instagram": "https://instagram.com/artist",
  "spotify":   null
}
```

- One key per entry in `BAND_LINK_FIELD_KEYS`, always all eight present, so a
  consumer never has to distinguish "absent" from "unset".
- The value is the **resolved href**, or `null`. Never a boolean, never a raw
  stored value, and never `"#"` -- a destination that would not navigate is
  reported as `null`, because a truthy `"#"` is precisely how #712 rendered an
  icon that went nowhere.
- Resolution is the existing contract: `normalizeHttpUrl` server-side, matching
  what `ArtistsPage` produces via `safeExternalHref`. A value containing
  whitespace or a scheme other than http(s) resolves to `null`.
- Counts and filters derive from this field, never from `social_links`. That is
  what makes the count on a filter chip agree with the icons a fan can see.
- The shuffle's single listen link is the first non-null of `bandcamp`,
  `spotify`, `apple_music`, `youtube` -- the same priority `ArtistsPage`
  already applies -- or omitted entirely when none resolves.

**Identity: the canonical `band_profiles.id`, everywhere it can be.** Artist
names here include `$wamp A$$` and names carrying slashes and apostrophes, and
an artist can be renamed -- the roster has already done it once (Suplex City ->
Suplex). A display name is not an identifier.

- `stage-mates` is keyed on the canonical **id**. The path segment is spelled
  `[name]` on disk for the routing reason above — do not read that as a licence
  to pass a display name.
  It is a new
  endpoint with no existing callers, so there is no URL contract to preserve,
  and its caller -- the artist profile page -- already has the id loaded.
- For continuity with `functions/api/bands/[name].js`, a non-numeric segment is
  still resolved through that file's existing normalisation rather than a second
  lookup. Ids are preferred; names keep working.
- Every artist any of these routes RETURNS carries its numeric id, so a caller
  never round-trips a display name to ask a follow-up question.
- The contact link carries the same id, and `/contact` uses it to identify the
  profile a correction is about. A bare `/contact` link cannot, which is the
  difference between a report we can act on and one we cannot.

Renaming the existing name-keyed public routes is deliberately **out of scope**:
those URLs are indexed and externally linked, and CLAUDE.md records the same
decision for `/event/` vs `/events/`. The rule here is that no NEW route adds to
that debt.

**Frontend**

- `ArtistsPage` gains a showcase block above the existing search, which is
  untouched -- it answers "is X playing?" and is the right tool for that.
- Each roster row gains the compact link icons the admin roster already renders,
  and the list gains per-platform toggles with counts.
- `BandProfilePage` gains "Shared a bill with" and the approved contact line.

## Open questions for the owner

1. **Shuffle placement:** above the A-Z list (prominent, pushes the roster down)
   or beside the search (quieter)? _Recommendation: above — the point is that it
   is seen._
2. **Does "one of one" need its own page,** or is a rotating single callout
   enough? _Recommendation: a callout first; a page only if it earns one._
3. ~~The contact line's wording~~ **Decided**: option A, on the artist profile
   page. See piece 4.

## Dependencies

- #1091 (members / "for fans of" fields) would enrich the artist page but does
  **not** block any of this.
