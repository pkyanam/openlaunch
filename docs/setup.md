# Setup gates

1. Authorize the pinned cf CLI from this cloud workspace, then verify account identity and openlaunch.dev zone. Credentials remain outside the repository.
2. Verify GitHub connection before creating or publishing a repository; no repository has been created yet.
3. Select and authorize a GitHub login OAuth application. Add the client secret through secure secret entry, not chat/source control.
4. Before provisioning paid Cloudflare services, verify credit eligibility/expiry and agree an operator spending limit. Reported credit is not an unlimited spending approval.
5. Configure separate development and production resources. Add a scoped CI deployment token through the owner's secure setup after the first manual deployment works.
6. Implement and verify OAuth/MCP, device enrollment and command authorization before exposing any device controls.
7. Real R4/Pi acceptance testing must be performed on connected hardware. Compiling on Linux is not device validation.

No OpenAI API key is needed for the core MCP bridge. Optional model-based evaluations or voice will need a separately approved API integration later.
