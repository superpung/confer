// GitHub OAuth token-exchange broker. The implementation lives in the shared
// package so every project reuses one broker; this project supplies its own
// GitHub OAuth App via GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (Netlify env).
export { handler } from '@superpung/gist-sync/netlify';
