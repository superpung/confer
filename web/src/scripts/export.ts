import type { Paper, Venue } from './types';

export interface ExportRow {
  paper: Paper;
  venue: Venue;
  note?: string;
  readStatus?: string;
  tags?: string[];
}

function bibKeyBase(row: ExportRow): string {
  const first = (row.paper.authors[0] ?? 'anon').split(/\s+/).pop() ?? 'anon';
  const word = (row.paper.title.match(/[A-Za-z0-9]+/) ?? ['paper'])[0];
  return `${first}${row.venue.year ?? ''}${word}`.replace(/[^A-Za-z0-9]/g, '');
}

function braces(value: string): string {
  return value.replace(/[{}]/g, '');
}

export function toBibtex(rows: ExportRow[]): string {
  // Deduplicate keys: if two entries share the same base key, suffix with b/c/d…
  const keyCounts = new Map<string, number>();
  const keyFor = (row: ExportRow) => {
    const base = bibKeyBase(row);
    const n = (keyCounts.get(base) ?? 0);
    keyCounts.set(base, n + 1);
    return n === 0 ? base : `${base}${String.fromCharCode(97 + n)}`;
  };
  return rows
    .map((row) => {
      const { paper, venue } = row;
      const type = venue.kind === 'journal' ? 'article' : 'inproceedings';
      const container = venue.kind === 'journal' ? 'journal' : 'booktitle';
      const lines = [
        `  title = {${braces(paper.title)}}`,
        `  author = {${paper.authors.map(braces).join(' and ')}}`,
        `  ${container} = {${braces(venue.name)}}`,
      ];
      if (venue.year) lines.push(`  year = {${venue.year}}`);
      if (paper.doi) lines.push(`  doi = {${braces(paper.doi)}}`);
      if (paper.urls[0]) lines.push(`  url = {${paper.urls[0]}}`);
      if (paper.pdfUrls?.[0]) lines.push(`  pdf = {${paper.pdfUrls[0]}}`);
      if (paper.abstract) lines.push(`  abstract = {${braces(paper.abstract)}}`);
      if (paper.keywords?.length) lines.push(`  keywords = {${paper.keywords.map(braces).join(', ')}}`);
      if (paper.pages) lines.push(`  pages = {${braces(paper.pages)}}`);
      if (paper.volume) lines.push(`  volume = {${braces(paper.volume)}}`);
      if (paper.issue) lines.push(`  number = {${braces(paper.issue)}}`);
      if (paper.publisher) lines.push(`  publisher = {${braces(paper.publisher)}}`);
      // User metadata: combine note, status, tags into annote
      const annoteParts: string[] = [];
      if (row.note) annoteParts.push(row.note);
      if (row.readStatus && row.readStatus !== 'unread') annoteParts.push(`[Status: ${row.readStatus}]`);
      if (row.tags?.length) annoteParts.push(`[Tags: ${row.tags.join(', ')}]`);
      if (annoteParts.length) lines.push(`  annote = {${braces(annoteParts.join(' '))}}`);
      return `@${type}{${keyFor(row)},\n${lines.join(',\n')},\n}`;
    })
    .join('\n\n');
}

function csvCell(value: string): string {
  const needsQuote = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

/** Markdown table (pipe-delimited) — pastes natively into Notion, Obsidian, etc. */
export function toTable(rows: ExportRow[]): string {
  if (!rows.length) return '';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = '| Title | Authors | Venue | Year | DOI | URL |';
  const sep = '|---|---|---|---|---|---|';
  const lines = rows.map(({ paper: p, venue: v }) => {
    const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
    const doi = p.doi ? `[DOI](https://doi.org/${p.doi})` : '';
    const url = p.urls[0] ? `[Link](${p.urls[0]})` : '';
    return `| ${cell(p.title)} | ${cell(authors)} | ${cell(v.name)} | ${v.year ?? ''} | ${cell(doi)} | ${cell(url)} |`;
  });
  return [header, sep, ...lines].join('\n');
}

export function toJson(rows: ExportRow[]): string {
  const data = rows.map(({ paper, venue }) => {
    const { _search, _aff, _insts, ...rest } = paper as Paper & Record<string, unknown>;
    void _search; void _aff; void _insts;
    return { venue: { id: venue.id, name: venue.name, year: venue.year, series: venue.series }, ...rest };
  });
  return JSON.stringify(data, null, 2);
}

export function toMarkdown(rows: ExportRow[]): string {
  if (!rows.length) return '';
  const byVenue = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const key = `${row.venue.name}||${row.venue.id}`;
    const arr = byVenue.get(key) ?? [];
    arr.push(row);
    byVenue.set(key, arr);
  }
  const sections: string[] = [];
  for (const [vKey, vRows] of byVenue) {
    const venueName = vKey.split('||')[0];
    const header = byVenue.size > 1 ? `## ${venueName}\n\n` : '';
    const papers = vRows.map((row) => {
      const { paper: p, note, readStatus, tags } = row;
      const authors = p.authors.join(', ') || 'Unknown';
      const links: string[] = [];
      if (p.urls[0]) links.push(`[Paper](${p.urls[0]})`);
      if (p.pdfUrls?.[0]) links.push(`[PDF](${p.pdfUrls[0]})`);
      if (p.doi) links.push(`[DOI](https://doi.org/${p.doi})`);
      if (p.artifactUrls?.[0]) links.push(`[Artifact](${p.artifactUrls[0]})`);
      const lines = [`### ${p.title}`, `**Authors**: ${authors}`];
      if (p.keywords?.length) lines.push(`**Keywords**: ${p.keywords.join(', ')}`);
      if (p.abstract) lines.push(`**Abstract**: ${p.abstract}`);
      if (links.length) lines.push(links.join(' · '));
      if (readStatus && readStatus !== 'unread') lines.push(`**Status**: ${readStatus}`);
      if (tags?.length) lines.push(`**Tags**: ${tags.join(', ')}`);
      if (note) lines.push(`> ${note}`);
      return lines.join('\n');
    }).join('\n\n---\n\n');
    sections.push(header + papers);
  }
  return sections.join('\n\n---\n\n');
}

export function toRis(rows: ExportRow[]): string {
  return rows.map(({ paper: p, venue, note, readStatus, tags }) => {
    const type = venue.kind === 'journal' ? 'JOUR' : 'CONF';
    const lines = [`TY  - ${type}`, `TI  - ${p.title}`];
    p.authors.forEach((a) => lines.push(`AU  - ${a}`));
    if (venue.kind === 'journal') {
      if (venue.name) lines.push(`JO  - ${venue.name}`);
    } else {
      if (venue.name) lines.push(`BT  - ${venue.name}`);
    }
    if (venue.year) lines.push(`PY  - ${venue.year}`);
    if (p.doi) lines.push(`DO  - ${p.doi}`);
    if (p.urls[0]) lines.push(`UR  - ${p.urls[0]}`);
    if (p.abstract) lines.push(`AB  - ${p.abstract.replace(/\n/g, ' ')}`);
    (p.keywords ?? []).forEach((kw) => lines.push(`KW  - ${kw}`));
    if (tags?.length) tags.forEach((tag) => lines.push(`LB  - ${tag}`));
    if (p.volume) lines.push(`VL  - ${p.volume}`);
    if (p.issue) lines.push(`IS  - ${p.issue}`);
    if (p.pages) lines.push(`SP  - ${p.pages}`);
    if (p.publisher) lines.push(`PB  - ${p.publisher}`);
    if (readStatus && readStatus !== 'unread') lines.push(`N1  - Status: ${readStatus}`);
    if (note) lines.push(`N1  - ${note}`);
    lines.push('ER  - ');
    return lines.join('\n');
  }).join('\n\n');
}

export function toCsv(rows: ExportRow[], opts?: { simScores?: Map<string, number> }): string {
  const hasSimScores = !!opts?.simScores?.size;
  const hasReadStatus = rows.some((r) => r.readStatus && r.readStatus !== 'unread');
  const hasTags = rows.some((r) => r.tags?.length);
  const hasArtifact = rows.some((r) => r.paper.artifactUrls?.length);
  const hasAbstractWc = rows.some((r) => r.paper.abstract?.trim());
  const header = [
    'venue', 'id', 'title', 'authorCount', 'authors', 'institutions', 'tracks',
    'eventType', 'sessions', 'dates', 'locations', 'doi', 'publicationDate',
    'publisher', 'container', 'volume', 'issue', 'pages', 'url', 'pdfUrl',
    ...(hasArtifact ? ['artifactUrl'] : []),
    'oaStatus', 'oaUrl', 'keywordCount', 'keywords', 'abstract', ...(hasAbstractWc ? ['abstractWordCount'] : []),
    ...(hasSimScores ? ['simScore'] : []),
    ...(hasReadStatus ? ['readStatus'] : []),
    ...(hasTags ? ['tags'] : []),
    'note',
  ];
  const lines = [header.join(',')];
  for (const { paper, venue, note, readStatus, tags } of rows) {
    const simPct = hasSimScores
      ? Math.round((opts!.simScores!.get(`${venue.id}:${paper.id}`) ?? 0) * 100)
      : null;
    lines.push(
      [
        venue.name,
        paper.id,
        paper.title,
        String(paper.authors.length),
        paper.authors.join('; '),
        paper.authorInstitutions,
        paper.tracks.join('; '),
        paper.eventType,
        paper.sessionTitles.join('; '),
        paper.dates.join('; '),
        paper.locations.join('; '),
        paper.doi ?? '',
        paper.publicationDate ?? '',
        paper.publisher ?? '',
        paper.container ?? '',
        paper.volume ?? '',
        paper.issue ?? '',
        paper.pages ?? '',
        paper.urls[0] ?? '',
        paper.pdfUrls?.[0] ?? '',
        ...(hasArtifact ? [paper.artifactUrls?.[0] ?? ''] : []),
        ((paper.extra as Record<string, unknown> | undefined)?.openAccess as { oa_status?: string } | undefined)?.oa_status ?? '',
        ((paper.extra as Record<string, unknown> | undefined)?.openAccess as { oa_url?: string } | undefined)?.oa_url ?? '',
        String(paper.keywords?.length ?? 0),
        paper.keywords?.join('; ') ?? '',
        paper.abstract ?? '',
        ...(hasAbstractWc ? [paper.abstract?.trim() ? String(paper.abstract.trim().split(/\s+/).length) : '0'] : []),
        ...(hasSimScores ? [simPct !== null && simPct > 0 ? String(simPct) : ''] : []),
        ...(hasReadStatus ? [readStatus && readStatus !== 'unread' ? readStatus : ''] : []),
        ...(hasTags ? [tags?.join('; ') ?? ''] : []),
        note ?? '',
      ].map((v) => csvCell(String(v ?? ''))).join(','),
    );
  }
  return lines.join('\n');
}
