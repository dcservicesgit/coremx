# Webmail portal

`/mail` is the default signed-in workspace. It uses Central's existing passkey session, API transport and CentralFW ingress. The generated Nuxt application is static; there is no Node/Nitro listening port. `/coremx` manages domains, mailbox assignment/quota, aliases, device credentials, provisioning policies and account-only wipe requests. Central's passkey enrollment and recovery pages remain available.

The mail view has a folder sidebar, paged message list, reading pane, conversation links, unread/starred filters, archive/move/trash actions and labels. Search supports phrases and mail properties, for example `from:maya@example.com`, `subject:launch`, `has:attachment`, `after:2026-09-01`, and `(launch OR review) NOT draft`. `/` focuses search; `C` opens the composer.

Appearance supports lavender light mode and purple dark mode on desktop and mobile. The sun/moon button switches modes and saves the mailbox preference. Settings → Appearance also offers “Use device setting”, which follows system changes automatically. Preferences are stored in the encrypted mailbox collection; a browser cache applies the choice to the administration and passkey pages and restores it while the mailbox loads.

HTML messages use matching dark reading colours in dark mode. “Show original colours” restores the message's own colours without changing the surrounding interface or relaxing the iframe sandbox and remote-image restrictions.

The composer supports To/Cc/Bcc, reply/reply-all/forward, signatures, attachments, server-side draft autosave and retry-safe sending. Closing saves a changed draft; discarding asks for confirmation. A send acknowledgement means the message is in the durable outbox. Postfix performs delivery; CoreMX creates the Sent copy after submission succeeds.

Calendar provides a month view, timezone-aware event editing, recurrence, guests, invitation responses and organizer handling of proposed times. Contacts has personal contact editing; recipient suggestions combine those contacts with the organization directory. Mailbox-specific settings store timezone, density and signature.

Editing an event created by a native client preserves its binary time-zone rules. The time-zone field shows “Original device time zone”; selecting an IANA name explicitly replaces that rule. Large message previews are bounded and offer a chunked download of the original message. Truncated drafts cannot be edited through the preview.

## Data boundaries

Every `mail.*` controller operation rechecks the Central passkey session and mailbox ownership. Being an administrator permits mailbox administration but does not grant webmail access to another user's messages. Reads, searches, conversation lookups, uploads, attachments, drafts, contacts and calendar operations select the mailbox collection before filtering. Native devices use separate revocable credentials and provisioning keys.

Drafts and uploaded attachment chunks use the encryptedkv chunk and transaction store. Upload references belong to one mailbox, expire after one hour and are bounded to 64 MiB of active uploads per mailbox. API chunks contain at most 384 KiB before base64 encoding; complete messages are limited to 32 MiB. The browser caps individual attachments at 24 MiB to allow for MIME encoding overhead.

HTML is sanitized on the server and rendered in a sandboxed, separate-origin iframe with a restrictive content security policy. Scripts, forms and embedded active content are removed. External images are blocked; selected raster CID images can be embedded. Attachment downloads use an octet-stream Blob and an explicit download action. Mail content does not enter the portal DOM through `v-html`.

## Browser verification

After composing and installing portal dependencies:

```sh
npm install --prefix .cache/browser playwright --ignore-scripts --no-audit --no-fund
mkdir -p .cache/browser/tmp
TMPDIR="$PWD/.cache/browser/tmp" node .cache/browser/node_modules/playwright/cli.js install chromium
TMPDIR="$PWD/.cache/browser/tmp" npm run test:browser
```

The browser test compiles the real Vue page and connects it to a temporary encrypted MailStore through Playwright bindings. Assets are fulfilled in memory. It verifies desktop reading, reply/send, draft save, contact creation, calendar creation, mobile layouts, both colour modes, system appearance changes, saved preferences after reload and HTML reading colours. Test mail is synthetic; SMTP is not connected. Screenshots are written to `.cache/screenshots/`. This checks the workspace interface and service integration; real passkey enrollment and a deployed CentralFW/TLS endpoint still need environment acceptance tests.
