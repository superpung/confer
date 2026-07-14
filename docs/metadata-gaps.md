# Metadata coverage gaps & backlog

Tracking of venues whose published data is missing **necessary metadata** —
author institutions (`authorInstitutions`) or abstracts (`abstract`) — with the
root cause and the fix direction. Driven by the principle in `AGENTS.md`:
**prefer a venue-native adapter** when a venue publishes the missing field on its
own site but we currently source it from a generic adapter.

Coverage is measured as the share of a venue's papers with a non-empty field.
Snapshot date: **2026-07-14** (regenerate with the audit script — see bottom).

## Legend — root-cause classes

- **A — Forced/generic adapter.** The venue publishes the missing field on its
  own official site, but we use a generic adapter (usually `dblp`) that cannot
  carry it. Fix = write a venue-native adapter (see `sigchi.py`, `ieeesp.py`).
- **B — First-party source already used, field not extracted.** We already read
  the venue's own API/site, but the adapter doesn't pull the field even though
  the source exposes it. Fix = enhance the existing adapter.
- **C — No clean first-party source.** The only authoritative source is
  paywalled / bot-walled (IEEE Xplore, ACM DL) or simply omits the field. Fix =
  none cheap; depends on enrichment (Crossref/OpenAlex) or is out of reach.

## Done

- **`sp2025` (IEEE S&P)** — was class A (`dblp`, 0% institutions). Now on the
  native `ieeesp` adapter → institutions 100%. (PR that introduced this file.)
- **`sosp2025` (SOSP)** — was class A (`dblp`, 0% institutions). Now on the
  native `sosp` adapter → institutions 100%, sourced from the official SIGOPS
  accepted-papers page. Abstracts backfilled from the prior DBLP-DOI enrichment.

## Missing author institutions

| venue | scraper | inst% | class | official source / note |
|---|---|--:|:--:|---|
| `iclr2026` | openreview | 0 | **B (blocked)** | Author affiliations live on author **profiles** (`/api/…/notes` gives author ids; profiles carry `history`/institution), not on the submission note the adapter reads. **As of 2026-07-14 the entire OpenReview API (`api2.openreview.net`) is behind a bot challenge** — every request (notes *and* profiles) returns `403 ChallengeRequiredError`. Fetching profiles now requires an authenticated session (OpenReview account token); until then this is not reachable without solving/bypassing the challenge. High value: ~5.4k papers. |
| `icml2025` | openreview | 0 | **B (blocked)** | Same as above (~3.3k papers). |
| `neurips2025` | openreview | 0 | **B (blocked)** | Same as above (~5.3k papers). |
| `acl2025` | acl_anthology | 0 | **C** | Confirmed: ACL Anthology metadata (bib/XML) carries **no** affiliations — only author names; they exist solely in the paper PDFs or the softconf/OpenReview program. No cheap structured source. |
| `ccs2025` | dblp | 0 | **C** (was A) | The SIGSAC site (`www.sigsac.org/ccs/CCS2025/`) is a statically-exported Next.js app; **no accepted-papers route or data endpoint is locatable** (all guessed paths 404, no JSON in the JS chunks). Previously assumed class A, but with no reachable first-party source it is effectively C until the page reappears. |
| `tse2025`, `tse2026` | dblp | 0 | **C** | IEEE TSE journal; only first-party source is IEEE Xplore (bot-walled). Abstracts already ~94% via enrichment. |
| `tosem2025`, `tosem2026` | dblp | 0 | **C** | ACM TOSEM journal; only first-party source is ACM DL (Cloudflare). Abstracts ~100% via enrichment. |

**Recommended next step:** the OpenReview trio (`iclr2026`/`icml2025`/`neurips2025`)
is still the biggest win — one adapter enhancement would resolve ~14k papers —
but it is **currently blocked** by OpenReview's new API-wide bot challenge (see
the table). It needs an authenticated OpenReview session to proceed; revisit once
credentials are available or the challenge is lifted. `sosp2025` is **done**
(native adapter). `ccs2025` has no reachable first-party source right now.

## Missing abstracts

| venue | scraper | abs% | class | note |
|---|---|--:|:--:|---|
| `micro2025` | sigarch | 24 | — | The official MICRO program page (`microarch.org`) lists titles/authors without abstracts; abstracts would have to come from enrichment, but recent DOIs may not be registered yet. Institutions already 100%. |
| `isca2026` | sigarch | 25 | — | Same pattern via `iscaconf.org`. Institutions already 100%. |
| `asplos2026` | sigarch | 67 | — | Partial enrichment coverage. |
| `ase2023` | researchr | 64 | — | Partial enrichment coverage (older event). |
| `popl2026` | researchr | 78 | — | Partial enrichment coverage. |

These are **not** wrong-adapter cases — the venue program pages simply omit
abstracts; coverage depends on Crossref/OpenAlex having a registered record.
They improve on their own as DOIs get indexed; a re-run once OpenAlex quota is
available typically lifts them.

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
