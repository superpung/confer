import type { Paper, Venue } from './types';

export interface ExportRow {
  paper: Paper;
  venue: Venue;
}

function bibKey(row: ExportRow): string {
  const first = (row.paper.authors[0] ?? 'anon').split(/\s+/).pop() ?? 'anon';
  const word = (row.paper.title.match(/[A-Za-z0-9]+/) ?? ['paper'])[0];
  return `${first}${row.venue.year ?? ''}${word}`.replace(/[^A-Za-z0-9]/g, '');
}

function braces(value: string): string {
  return value.replace(/[{}]/g, '');
}

export function toBibtex(rows: ExportRow[]): string {
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
      if (paper.urls[0]) lines.push(`  url = {${paper.urls[0]}}`);
      return `@${type}{${bibKey(row)},\n${lines.join(',\n')},\n}`;
    })
    .join('\n\n');
}

function csvCell(value: string): string {
  const needsQuote = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function toCsv(rows: ExportRow[]): string {
  const header = [
    'venue', 'id', 'title', 'authors', 'institutions', 'tracks',
    'eventType', 'sessions', 'dates', 'locations', 'url',
  ];
  const lines = [header.join(',')];
  for (const { paper, venue } of rows) {
    lines.push(
      [
        venue.name,
        paper.id,
        paper.title,
        paper.authors.join('; '),
        paper.authorInstitutions,
        paper.tracks.join('; '),
        paper.eventType,
        paper.sessionTitles.join('; '),
        paper.dates.join('; '),
        paper.locations.join('; '),
        paper.urls[0] ?? '',
      ].map((v) => csvCell(String(v ?? ''))).join(','),
    );
  }
  return lines.join('\n');
}
