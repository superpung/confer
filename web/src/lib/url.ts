/** Prefix a path with Astro's configured `base` so links work under /<repo>/. */
export function withBase(pathname: string): string {
  const base = import.meta.env.BASE_URL; // e.g. "/" or "/dac26/"
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${left}${right}` || '/';
}
