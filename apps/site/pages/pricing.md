# Pricing

Free to start. Built to scale with your team.

openlaunch is open source. Use it free, self-host it anywhere, and pay only when
your team needs more control.

## Free — $0 / month

Available now, for individuals and early projects.

- Unlimited devices and agent connections, subject to hosted fair-use limits
- Full MIT open-source stack, self-hostable
- Per-function grants and revocation
- Action receipts and baseline history
- Community support

[Start free](/console/). No subscription required.

## Team — On the way…

Planned for teams sharing devices and agents. Seat-based pricing; no price or
launch date set. Planned features: shared workspaces and roles, device groups
and larger broadcasts, longer history and export options, approval notifications.

[Get notified](mailto:info@belweave.com?subject=openlaunch%20Team%20waitlist).

## Enterprise — Custom

Contact Belweave to discuss self-hosted or dedicated deployment needs, onboarding,
custom adapters, security review and support requirements. SSO/SAML, SCIM, audit
retention controls, SIEM export and organization policies are planned. Scope and
commitments are agreed individually. No certification, SLA or compliance commitment
is included by default.

[Contact us](mailto:info@belweave.com?subject=openlaunch%20Enterprise%20inquiry).

## Questions

### Is it really free?

Yes. The existing first-party stack is MIT-licensed, with no paid feature gates.
There is no plan-level device or agent cap. Hosted rate, storage and concurrency
limits apply. See [hosted limits](/docs/api#download-activity).

### What will Team cost?

Pricing is not final. Team will be priced per active member. Email
info@belweave.com to hear when it launches.

### Can I self-host and use the cloud together?

Yes. Both use the same public codebase. Each deployment keeps its own devices
and permissions.

### What history is included?

Up to 5,000 action records and the latest 1,000 audit events within a 16 MiB logical
storage budget per workspace. Older settled receipts past TTL may be pruned as
new work arrives. Pending and uncertain actions are preserved. Retired request
keys cannot execute again. Export history you want to keep.

### How do permissions work?

Pairing does not authorize an agent. Grant specific functions per device, revoke
access and inspect retained receipts. Revocation can prevent queued work but
cannot guarantee that an action already started stops. Use independent physical
safety controls.

See [verification status](/docs/status) for hardware acceptance evidence.

Operated by Belweave. [Source](https://github.com/pkyanam/openlaunch),
[Terms](/docs/terms), [Privacy](/docs/privacy), [Contact](mailto:info@belweave.com).
