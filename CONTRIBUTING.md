# Contributing to openlaunch

openlaunch is maintained by Belweave. The public repository is also the production
repository: hosted and self-hosted openlaunch use the same codebase. Belweave sets
release priorities and maintains `main` for community functionality and the
flagship hosted service. Contributions are welcome; acceptance and deployment
remain maintainer decisions.

## Before changing code

For substantial changes, open an issue describing the problem, intended behavior
and tradeoffs before implementing. Small fixes can go directly to a pull request.
Read [AGENTS.md](AGENTS.md) and [README.md](README.md). Keep transports, device
adapters, authorization and agent integrations independent. Use lowercase
`openlaunch` in prose. Do not commit credentials or unrelated changes.

Use the pinned dependencies and CLI versions in the repository. With Node 24 or
newer, run `npm ci`, then `npm run check`. Website changes also need
`npm run build:pi`, `npm run build:site` and `npm run check:site`. Describe the
checks you ran and any checks you could not run in your pull request.

## Permissions and physical devices

Model output cannot authorize itself. Keep setup, agent and device credentials
separate. Changes affecting actions must account for grants, expiry, duplicate
delivery, reconnect and revocation. Use bounded parameters and preserve independent
physical safety controls. Do not add unrestricted shell or arbitrary LAN proxying
by default. Report fixtures and simulations as software checks, never physical
hardware acceptance. Update verification documentation only with supporting evidence.

Report security issues privately to info@belweave.com rather than posting exploit
or credential details in public issues. Do not operate anyone else's hardware.

## License and sign-off

Existing first-party code is under the [MIT license](LICENSE). Contributions to
that code are submitted under MIT; preserve third-party license notices. Future
separately licensed additions must explicitly state their license and scope.
There is no separate enterprise implementation in this release.

We use the [Developer Certificate of Origin 1.1](DCO). By adding a sign-off to
each commit, you certify that you have the right to submit the contribution under
its stated license. You keep your copyright; this is not a copyright assignment.

Use `git commit -s` to add `Signed-off-by: Your Name <your-email>` with an identity
you can stand behind. If you forgot a sign-off on your latest commit, add it with
`git commit --amend --signoff` before submitting. Do not rewrite shared branch
history without coordinating with collaborators.
