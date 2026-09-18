# Security

This is a community field-test release, not a safety-certified machine control
system. Keep normal physical supervision and machine safeguards in place.

- Use a private or authenticated MQTT broker, preferably with TLS.
- Restrict broker ACLs to the plugin's state, command, event, and discovery topics.
- Anyone allowed to publish to the command topic can request supported controls.
- TLS uses the tablet's platform trust store; custom CA and mutual TLS are not
  currently supported by Decaid's plugin transport.
- Password storage depends on Decaid version. Decaid 0.8.5 uses ordinary plugin
  settings; newer releases support the manifest's secure credential flag.
- Never include passwords, tokens, or unredacted credentials in issues or logs.

For a suspected vulnerability, contact the maintainer through the contact
details on the GitHub profile before posting exploit details publicly. A
dedicated private vulnerability reporting channel is not configured yet.
