// Runtime-typed API client for browser-side fetches.
//
// Binds path + method + query/path params + request/response shapes together
// against the auto-generated OpenAPI `paths` (see `./types`), so a wrong path,
// missing param, or mismatched body/response is a compile-time error rather
// than a manual `as T` cast at the call site.
//
// Same-origin base (`/`): components hit the Next.js proxy routes under
// `src/app/api/**`, which stream the backend response through unchanged. Those
// proxies stay untyped pass-throughs by design (they only exist to keep
// `API_URL` server-side); this client types the browser end of that hop.
import createClient from "openapi-fetch";
import type { paths } from "./types";

export const api = createClient<paths>({ baseUrl: "/" });
