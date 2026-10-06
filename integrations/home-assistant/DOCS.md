# openlaunch Home Assistant app

1. In https://www.openlaunch.dev/console/, choose **Devices → Add device → Home Assistant**. Create a setup token.
2. In this app's **Configuration**, paste it into `setup_token` and save. Enable **Start on boot** and start the app.
3. Back in openlaunch, open Home Assistant's **Access**, choose ChatGPT, and **Grant current Home Assistant devices**. Set the access expiry you want.
4. Connect ChatGPT to `https://www.openlaunch.dev/mcp` using OAuth. Ask it to list your devices and control an entity.

The app uses Home Assistant's local API proxy automatically. No HA URL, HA access token, incoming port or router configuration is needed. Setup credentials only attach a gateway; agents receive separate OAuth/API credentials and per-device function grants. The app's API permission allows it to discover HA states and services, while openlaunch grants determine what connected agents may invoke.

Your pairing and durable action journal persist in `/data/openlaunch/`. Restarting or updating reuses them. The app downloads the checksum-verified SDK matching the deployed website at startup. An unchanged manifest retains grants; new entities and changed manifests require approval. The short-lived setup token can be cleared after pairing. Never share private configuration or journals publicly.

An empty HA installation works. Add a **Toggle** helper in Settings → Devices & services → Helpers to test on/off and state reads without hardware. Home Assistant acceptance and a returned entity state do not verify physical operation. Read the full guide at https://www.openlaunch.dev/docs/home-assistant.

If a command was interrupted, inspect the HA state and app logs before retrying. The journal prevents automatically replaying a command with an uncertain outcome. For an interrupted action, stop the app and inspect HA. Copy the exact interrupted action ID from its logs into `recovery_action_id` in app Configuration, save and restart to acknowledge that one unknown outcome. Clear that field afterward. This never replays a command or confirms success. A stopped app becomes offline. Existing grants remain saved across temporary upstream/network outages.
