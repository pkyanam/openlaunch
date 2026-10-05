# Blume coverage

openlaunch pins Blume 2.1.1. This records every category in the official documentation navigation and how it applies to this project. The maintained website remains monochrome. Features are built from the same GitHub commit and deployed within the existing Cloudflare setup; this work adds no paid services.

| Blume area | openlaunch implementation or decision |
| --- | --- |
| Getting started | Setup, deployment and troubleshooting guides; npm scripts use the pinned installation. Migration and upgrade guides inform maintenance, rather than becoming user setup steps. |
| Content: pages, navigation, folder meta, frontmatter and syntax | Local MDX with deliberate ordering; Docs/API/CLI/Agents/Updates header navigation; descriptive metadata and search keywords. |
| Content: includes and variables | Canonical API/MCP URLs and the CLI install command are centralized in config variables. No duplicate includes are needed for the current small guides. |
| Content: components and islands | Native operation schemas, examples, language tabs and interactive Try it; the custom homepage and React owner console are separate surfaces. |
| Content: internationalization and versioning | English and the current API contract only. No incomplete translations or duplicate older versions are advertised. Modern and legacy MCP compatibility is documented explicitly. |
| Content sources | Git-tracked docs and a build-generated OpenAPI contract. CI draws installers and archives from checked GitHub source. No GitHub Release feed is enabled because no versioned release exists. Obsidian, remote MDX, Sanity, Notion, Contentful, Payload, Strapi and custom CMS adapters are unnecessary for this source-owned site. |
| Configuration: config, theming and customization | Pinned config, monochrome theme, custom homepage, logo and console link. |
| Configuration: search | Local Orama search, useful initial links, keywords and code-block indexing; generated endpoint operations participate. No paid search provider. |
| Configuration: assistant and rate limiting | No model-backed site assistant or provider credentials added. The authenticated bridge already enforces request admission/rate limits; the documentation MCP uses bounded requests. A future assistant needs its own cost and abuse review. |
| Configuration: narration and export | Browser-native narration, PDF print/export, EPUB and Markdown. No narration API bill. |
| Configuration: analytics and cookie consent | No new tracking or analytics service; no empty consent UI. Owner authentication is described separately in the privacy policy. |
| Discoverability: SEO/GEO, metadata, Open Graph and structured data | Native metadata, canonical URLs, generated OG and structured data for normal docs and reference operations; intentional homepage metadata. |
| Discoverability: RSS, sitemap and robots | Native dated update timeline and RSS, sitemap and robots. Update notes link verified software commits and preserve hardware limitations. |
| Discoverability: llms.txt and Markdown | llms index/full text, Markdown/MDX mirrors and Accept: text/markdown, including generated operation pages and SDK/CLI examples. |
| Discoverability: JSON API and MCP | Blume's public documentation JSON API/OpenAPI and `/docs-mcp` are separate from authenticated `/v1` and `/mcp`. Device API contract is `/device-api.json`; `/openapi.json` describes public documentation retrieval. |
| Discoverability: agent discovery | Explicit readability manifest, AI/API/MCP catalogs, generated site skill and native documentation resources. Device/function catalogs are live and grant-filtered. |
| Advanced: skills and custom pages | Generated skill and homepage, custom Pages worker for documentation MCP and forwarding to the existing authenticated bridge. No arbitrary proxy. |
| Advanced: changelog and blog | Dated software update notes and native feed. No fictional releases, customer posts or unused blog. |
| References: OpenAPI | Native OpenAPI 3.1 reference generated from shared request validators, with authentication, endpoint schemas, errors, examples, Try it and custom SDK/ol samples. |
| References: hand-written API pages | End-to-end API workflow and SDK guides complement the endpoint reference. |
| References: AsyncAPI, GraphQL and Scalar | No GraphQL or durable event subscription API exists. WebSocket wake hints are documented in the actual HTTP contract. Scalar is an alternative renderer; native Blume pages provide search/Markdown/MCP integration without a second UI. |
| CLI: overview, doctor, validate and audit | Pinned npm site scripts validate content, audit accessibility/links and exercise documentation MCP. `ol` is the separately installed product CLI. |
| CLI: evals, translate and version | No model-backed assistant to evaluate; no automatic translation or stale version snapshot. Software verification covers published content and contracts. |

The Blume marketing navigation also links Agents, Compare, Customers, Guides, Changelog and Pricing. openlaunch exposes its own agent guide, workflow guides, real update notes and implemented interface choices. It does not claim customers, comparison benchmarks, a commercial plan or physical success without evidence.

Sources: [Blume documentation](https://useblume.dev/docs), [2.1 changes](https://useblume.dev/changelog/blume-2-1-0), [configuration](https://useblume.dev/docs/configuration), [OpenAPI reference](https://useblume.dev/docs/references/openapi), [agent discovery](https://useblume.dev/docs/discoverability/agent-discovery), [changelog](https://useblume.dev/docs/advanced/changelog), [CLI](https://useblume.dev/docs/cli).
