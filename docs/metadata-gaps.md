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

## Missing author institutions

| venue | scraper | inst% | class | official source / note |
|---|---|--:|:--:|---|
| `iclr2026` | openreview | 0 | **B** | OpenReview API already used; author affiliations live on author **profiles** (`/api/…/notes` gives author ids; profiles carry `history`/institution), not on the submission note the adapter currently reads. High value: ~5.4k papers. |
| `icml2025` | openreview | 0 | **B** | Same as above (~3.3k papers). |
| `neurips2025` | openreview | 0 | **B** | Same as above (~5.3k papers). |
| `acl2025` | acl_anthology | 0 | **B/C** | ACL Anthology metadata (bib/XML) does not include affiliations; they exist only in the paper PDFs or the softconf/OpenReview program. No cheap structured source. |
| `ccs2025` | dblp | 0 | **A** | Official accepted list `https://www.sigsac.org/ccs/CCS2025/accepted-papers/` lists authors **with** affiliations, but the page renders them via JavaScript — the static HTML is empty. Needs the underlying data endpoint/JSON (not yet located). |
| `sosp2025` | dblp | 0 | **A** | Official `https://sigops.org/s/conferences/sosp/2025/accepted.html` shows affiliations inline, but in a loosely-structured "authors, then institutions" block that is riskier to parse than S&P's superscript scheme. Only 66 papers. |
| `tse2025`, `tse2026` | dblp | 0 | **C** | IEEE TSE journal; only first-party source is IEEE Xplore (bot-walled). Abstracts already ~94% via enrichment. |
| `tosem2025`, `tosem2026` | dblp | 0 | **C** | ACM TOSEM journal; only first-party source is ACM DL (Cloudflare). Abstracts ~100% via enrichment. |

**Recommended next step:** the OpenReview trio (`iclr2026`/`icml2025`/`neurips2025`)
is the biggest win — one adapter enhancement resolves ~14k papers. Then the two
class-A conferences (`ccs2025`, `sosp2025`).

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
