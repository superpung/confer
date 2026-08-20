# Metadata coverage gaps & backlog

Tracking of venues whose published data is missing **necessary metadata** —
author institutions (`authorInstitutions`) or abstracts (`abstract`) — with the
root cause and the fix direction. Driven by the principle in `AGENTS.md`:
**prefer a venue-native adapter** when a venue publishes the missing field on its
own site but we currently source it from a generic adapter.

Coverage is measured as the share of a venue's papers with a non-empty field.
Snapshot date: **2026-08-20** (regenerate with the audit script — see bottom).

## Legend — root-cause classes

- **A — Forced/generic adapter.** The venue publishes the missing field on its
  own official site, but we use a generic adapter (usually `dblp`) that cannot
  carry it. Fix = write a venue-native adapter (see `sigchi.py`, `ieeesp.py`).
- **B — First-party source already used, field not extracted.** We already read
  the venue's own API/site, but the adapter doesn't pull the field even though
  the source exposes it. Fix = enhance the existing adapter.
- **D — Present but in a shape the site cannot read.** The scrape carries the
  affiliations, but not as the `Name (Institution); …` display string the site
  parses, so they are invisible in facets and author cards. Fix = normalize in
  the adapter. (`osdi2025`/`nsdi2026`/`usenixsecurity2025`/`aaai2026` were this.)
- **C — No clean first-party source.** The only authoritative source is
  paywalled / bot-walled (IEEE Xplore, ACM DL) or simply omits the field. Fix =
  none cheap; depends on enrichment (Crossref/OpenAlex) or is out of reach.

## Done

- **`sp2025` (IEEE S&P)** — was class A (`dblp`, 0% institutions). Now on the
  native `ieeesp` adapter → institutions 100%. (PR that introduced this file.)
- **`sosp2025` (SOSP)** — was class A (`dblp`, 0% institutions). Now on the
  native `sosp` adapter → institutions 100%, sourced from the official SIGOPS
  accepted-papers page. Abstracts backfilled from the prior DBLP-DOI enrichment.
- **`osdi2025`, `nsdi2026`, `usenixsecurity2025` (USENIX)** — were class D. The
  USENIX presentation page groups authors by institution (`"A, B, and C, Inst;
  D, Inst2"`), which the adapter stored verbatim, so the site read it as one
  unparsable blob. The adapter now consumes names from each group using the
  page's own `citation_author` list and emits `Name (Institution)` →
  institutions 94% / 93% / 93%. The remainder are pages whose byline spells a
  name the meta tags do not list; those keep the raw byline rather than guess.
- **`aaai2026` (AAAI)** — was class D. OJS emits one
  `citation_author_institution` per `citation_author`, in order; the adapter
  stored only the institution list, which the site could not tie to an author
  in facets. Zipped into `Name (Institution)` → institutions 100%.
- **`ccs2025`, `tosem2025`, `tosem2026`, `tse2025`, `tse2026`** — were class C
  (0% institutions, no reachable first-party source). Crossref carries per-author
  `affiliation` for both ACM and IEEE records; the enricher discarded it and only
  ever filled institutions for papers with no authors at all. It now fills them
  whenever the venue's own source has none → institutions 100% for all five.

## Missing author institutions

| venue | scraper | inst% | class | official source / note |
|---|---|--:|:--:|---|
| `iclr2026` | openreview | 0 | **B (blocked)** | Author affiliations live on author **profiles** (`/api/…/notes` gives author ids; profiles carry `history`/institution), not on the submission note the adapter reads. **As of 2026-07-14 the entire OpenReview API (`api2.openreview.net`) is behind a bot challenge** (re-checked 2026-08-20: still `403`) — every request (notes *and* profiles) returns `403 ChallengeRequiredError`. Fetching profiles now requires an authenticated session (OpenReview account token); until then this is not reachable without solving/bypassing the challenge. High value: ~5.4k papers. |
| `icml2025` | openreview | 0 | **B (blocked)** | Same as above (~3.3k papers). |
| `neurips2025` | openreview | 0 | **B (blocked)** | Same as above (~5.3k papers). |
| `acl2025` | acl_anthology | 0 | **C** | Confirmed: ACL Anthology metadata (bib/XML) carries **no** affiliations — only author names; they exist solely in the paper PDFs or the softconf/OpenReview program. No cheap structured source. |

**Recommended next step:** the OpenReview trio (`iclr2026`/`icml2025`/`neurips2025`)
is still the biggest win — one adapter enhancement would resolve ~14k papers —
but it is **currently blocked** by OpenReview's new API-wide bot challenge (see
the table). It needs an authenticated OpenReview session to proceed; revisit once
credentials are available or the challenge is lifted. `sosp2025` is **done**
(native adapter), as are the USENIX trio, `aaai2026`, and the Crossref-backfilled
`ccs2025` / `tosem*` / `tse*` (see **Done**). What is left in this table is only
what no reachable source can currently answer.

## Missing abstracts

| venue | scraper | abs% | class | note |
|---|---|--:|:--:|---|
| `micro2025` | sigarch | 24 | — | The official MICRO program page (`microarch.org`) lists titles/authors without abstracts; abstracts would have to come from enrichment, but recent DOIs may not be registered yet. Institutions already 100%. |
| `isca2026` | sigarch | 25 | — | Same pattern via `iscaconf.org`. Institutions already 100%. |
| `asplos2025` | sigarch | 0 | — | Same pattern via `asplos-conference.org`; on top of that OpenAlex rate-limited (HTTP 429) every DOI lookup during the build, so enrichment filled nothing. Institutions already 100% and 87% have a DOI from Crossref — a re-run once the OpenAlex quota frees up should lift abstracts. (measured 2026-08-20) |
| `asplos2026` | sigarch | 67 | — | Partial enrichment coverage. |
| `ase2026` | researchr | 37 | — | The tracks publish accepted papers ahead of the October 2026 conference: most carry no abstract on the program page and no DOI is registered yet, so enrichment cannot fill them. Institutions already 100%; expect this to lift on a re-run after the proceedings are indexed. (measured 2026-08-20) |
| `ase2023` | researchr | 64 | — | Partial enrichment coverage (older event). |
| `popl2026` | researchr | 78 | — | Partial enrichment coverage. |

These are **not** wrong-adapter cases — the venue program pages simply omit
abstracts; coverage depends on Crossref/OpenAlex having a registered record.

**Crossref cannot close this gap:** spot-checking the missing ones (`micro2025`,
`asplos2026`, `ase2023`, `sosp2025`) shows ACM and IEEE deposit author
affiliations but **no abstract** for conference papers, so OpenAlex is the only
source — and on 2026-08-20 OpenAlex was rate-limiting this host hard (2 of 8
sequential requests succeeded; the enricher disables itself after the first
failure). A re-run from a host OpenAlex is not throttling is what lifts these,
not an adapter change.

## Regenerating this snapshot

```bash
cd /path/to/confer
scraper/.venv/bin/python - <<'PY'
import json, glob, os, yaml
cfg={v['id']:v for v in yaml.safe_load(open('config/venues.yaml'))['venues']}
rows=[]
for f in sorted(glob.glob('web/public/data/*.json')):
    vid=os.path.basename(f)[:-5]
    if vid=='venues': continue
    p=json.load(open(f))
    if not isinstance(p,list) or not p: continue
    pct=lambda k: round(100*sum(1 for x in p if x.get(k) not in (None,'',[],{}))/len(p),1)
    rows.append((vid,len(p),pct('abstract'),pct('authorInstitutions'),cfg.get(vid,{}).get('scraper','?')))
for r in sorted(rows,key=lambda r:min(r[2],r[3])):
    print(f'{r[0]:<20}{r[1]:>6}{r[2]:>7}{r[3]:>7}  {r[4]}')
PY
```
