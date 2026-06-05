import { defineConfig } from 'astro/config';

// `base` controls the URL prefix. For GitHub Project Pages (served at
// /<repo>/) set BASE_PATH=/dac26 at build time; locally it defaults to '/'.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://superpung.github.io',
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'ignore',
});
