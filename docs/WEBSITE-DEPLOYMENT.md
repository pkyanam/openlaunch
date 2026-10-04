# openlaunch website deployment

## Surface and current state

`apps/site` is an npm workspace using pinned Blume 2.1.1. Its custom Astro homepage and seven searchable Markdown guides build to static HTML. It has no device controls, OAuth endpoints, dashboard sessions or server functions. The existing local React console and cloud bridge remain separate.

Verified on October 4, 2026:

- Existing checkout matched `8dc5c73` and was clean before website work.
- Official `cf` npm CLI is pinned at `1.0.0-beta.12` (current published version).
- CLI identity is `preetham@belweave.com`; intended account ID is `98117dde620017491911477efef1efbb`.
- The credits endpoint returned 403. The reported $10,000 balance, expiration and product eligibility are **unverified**.
- Owner approved up to **$10/month**, keeping Vercel authoritative DNS and using `www` first. This is an approval ceiling, not an enforced provider billing cap. Provision only a free static site; do not enable paid Functions, Durable Objects, databases or AI services for the website.
- Old Cloudflare `openlaunch-control-plane` Worker was inspected (no references) and deleted with owner authorization. Vercel `openlaunch` project was deleted. `strikepoint` remains unrelated and intact.
- The owner deleted the old Clerk application. Its five Clerk CNAMEs were removed from Vercel DNS. Nameservers, CAA and unrelated verification records were preserved. No MX records were observed; this is not proof of historical absence of email configuration.
- No Cloudflare Pages project exists yet. Git-integrated project creation returned `8000011`, invalid Pages Git installation. Repair/authorize Cloudflare's GitHub installation for `pkyanam/openlaunch` in the intended account.

No production website or device-control deployment is claimed by these preparation steps. While the new site is pending, the former domain app has been removed and the default Vercel apex/wildcard records can return a missing-deployment response.

## Supported cf workflow

`cf pages deploy` in this CLI version is a stub that explicitly rejects legacy Pages upload. Do not use Wrangler. Use the generated Pages REST commands for Git-integrated static hosting. Git authorization is a prerequisite, not something the site build supplies.

After GitHub installation is repaired, create the project with `cf pages create` and these settings (or use its `--body` JSON option):

```json
{
  "name": "openlaunch-site",
  "production_branch": "main",
  "build_config": {
    "build_command": "npm run build:site",
    "destination_dir": "apps/site/dist",
    "root_dir": ""
  },
  "deployment_configs": {
    "production": {
      "env_vars": { "NODE_VERSION": { "type": "plain_text", "value": "24" } }
    },
    "preview": {
      "env_vars": { "NODE_VERSION": { "type": "plain_text", "value": "24" } }
    }
  },
  "source": {
    "type": "github",
    "config": {
      "owner": "pkyanam",
      "owner_id": "37784174",
      "repo_name": "openlaunch",
      "repo_id": "1403431848",
      "production_branch": "main",
      "deployments_enabled": false,
      "production_deployments_enabled": false,
      "preview_deployment_setting": "none"
    }
  }
}
```

Pin `CLOUDFLARE_ACCOUNT_ID` to the intended account in the deployment process environment. Do not commit credentials. First check `cf auth whoami`, `cf pages list`, and the current main commit. Inspect an existing project instead of blindly recreating it. Disabled automatic deployments keep an unverified push from publishing by itself.

Run a manual Git deployment **after CI succeeds**:

```sh
npm ci
npm run build:site
npm run check:site
cf pages deployments create openlaunch-site --branch main
cf pages deployments list --project-name openlaunch-site
```

Inspect the returned deployment's commit hash; a Git branch deployment uses that branch's actual HEAD, not a commit value pasted into a flag. Wait for success before domain association. No upload manifests or temporary credentials need to be printed or committed.

## Domain association

Cloudflare's documented external-DNS path supports `www.openlaunch.dev`. Its apex Pages path requires a Cloudflare zone and Cloudflare nameservers. The owner selected Vercel DNS and www first; do not invent an apex ALIAS to Pages or move nameservers.

After a successful deployment:

1. Add `www.openlaunch.dev` with `cf pages domains create openlaunch-site --name www.openlaunch.dev` (confirm current help/schema).
2. Inspect Cloudflare's response and use the **actual returned** Pages target in an explicit `www` CNAME through Vercel. Re-read DNS first. Do not change wildcard, verification or email records unintentionally.
3. Verify domain validation, authoritative DNS, HTTPS with normal certificate checks, homepage, `/docs/setup`, `/docs/uno-r4`, search assets and `/deployment.json`.
4. Compare `deployment.json.commit` and Cloudflare's deployment trigger commit to the CI-passing GitHub commit; require `dirty: false`.
5. Confirm `/mcp` and management routes do not expose controls; the static site should return 404.

Apex redirection needs a separately configured HTTPS redirect service at the authoritative provider or a reviewed zone migration. `www` publication alone does not restore apex HTTPS. Keep this limitation explicit until an apex redirect is deployed and verified.

## Validation

Root `npm run build` includes the site. CI builds it and runs Blume link validation/audit on macOS and Linux. `postbuild` adds the custom homepage to the agent index, emits security headers, and records the source commit plus dirty state in `deployment.json`. Build output and generated `.blume` stay ignored.

The dependency override pins the Vercel routing adapter's transitive `path-to-regexp` to its compatible patched 6.3.0 version; npm audit reports zero vulnerabilities. The public deployment contains only static files, not these build-time packages.

## Hosted auth remains a separate gate

Before exposing the bridge publicly: select/configure a maintained login provider and Cloudflare OAuth provider, implement owner sessions and client consent, test PKCE/state/redirect allowlists, scope isolation, refresh/revocation and tenant boundaries, and verify device authentication on a protected deployment. The deleted Clerk app is not a new login provider. Static website hosting does not complete this work.

Hardware acceptance instructions are in `MAC-HANDOFF.md`, `UNO-R4-PROFILES.md` and the site guides. Never flash the custom ESP firmware, publish repair assets, or describe a simulated receipt as physical success.
