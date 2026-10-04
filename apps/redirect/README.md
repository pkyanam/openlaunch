# openlaunch apex redirect

This static Vercel project redirects `https://openlaunch.dev/:path` to `https://www.openlaunch.dev/:path`, preserving paths and query strings. Cloudflare serves the website, installers, documentation MCP and authenticated bridge.

Vercel remains authoritative for DNS. Keep the `www` CNAME and all Clerk records intact. This project has no functions, credentials or device controls. Its GitHub project root is `apps/redirect`, with empty install and build commands.
