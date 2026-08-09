// No-op shim for the `server-only` package when bundled into token-api-server.
// token-api-server is a plain Node.js process, not a Next.js server component,
// so the guard that server-only enforces is not applicable.
