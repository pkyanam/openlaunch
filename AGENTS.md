# openlaunch development

Always lowercase the product name. Work alone unless the owner explicitly changes that direction. This task uses the dot cloud workspace; real hardware testing will happen later on the owner's Mac.

Primary targets: Uno R4 WiFi and Pi 4 Model B. Keep transports, device adapters, authorization and agent integrations independent. No provider-specific credentials on firmware.

Use the pinned cf CLI. The owner authorized pinned Wrangler as a fallback on October 4, 2026 when cf cannot perform the required upload. Never add secrets to files tracked by Git. No cloud provisioning, DNS changes, OAuth grants, token creation or production deployment without the applicable owner approval. Never advertise a stub or simulated result as a live device success.

Check grant boundaries, command expiry, duplicate delivery, reconnect and revocation. Model output cannot authorize itself. No unrestricted shell or arbitrary LAN proxy by default.
