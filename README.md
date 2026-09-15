# CoreMX

A Central-based mail application with CentralFW as its only web ingress. This repository contains a sparse portal/server overlay and its composition script. Shared encryption, runtime and gateway improvements live in the adjacent Central repository.

**Status:** Central-based encrypted mail storage, a webmail portal and an experimental ActiveSync 14.1/16.0/16.1 implementation. ActiveSync remains disabled by default pending native-device acceptance; see the [implementation and compatibility matrix](docs/conformance.md).

All mail data is stored in Central’s `encryptedkv`: message bodies and attachments use encrypted chunk records; metadata, folders, outbox records, uploads, contacts, calendar and device sync state use one collection per mailbox. Recovery journals also live in `encryptedkv`, with no separate mail data files. The ActiveSync service includes smart replies/forwards, invitation workflows, recurrence and timezone validation, mailbox/GAL search, recipient resolution, provisioning enforcement, account-only wipe, draft attachments and additional Sync variants.

Open `/mail` for the responsive webmail, calendar and contacts workspace; `/coremx` manages domains, mailbox assignments, aliases, device passwords and policies. See [the portal guide](docs/webmail.md).

## Build

Use Node.js 24 and the updated Central checkout, including `applicationProfile`, HTTP worker support, byte encryption helpers, and the corresponding CentralFW binary. Central's `build.sh` accepts `CENTRAL_BUILD_TARGETS` and emits a capability manifest with the binary checksum. Rebuild the required target before composing. The default binary is Linux musl for the build host; set `CENTRALFW_BINARY` to select another packaged target.

```sh
./build_compositeserver.sh --no-install
npm ci --prefix composite_server
npm ci --prefix composite_portal
npm run generate --prefix composite_portal
```

Without `--no-install`, the composer also installs portal dependencies. `CENTRAL_DIR` defaults to `../central`. `COREMX_WEBSOCKET_ENDPOINT` optionally overrides the browser endpoint; otherwise it uses same-origin `/ws`. Generated directories are disposable and excluded from Git. The build records source revisions, dirty flags and the CentralFW binary checksum in `composite_server/composition.json`.

## Configure

Merge [deploy/coremx.example.json](deploy/coremx.example.json) into a **separately provisioned Central installation configuration**, including its own encryption keys, KV endpoints and identity bootstrap settings. The example is an overlay, not a complete Central configuration. Keep real configuration outside build outputs.

Use [deploy/coremx.service](deploy/coremx.service) as the service template. Provision `/etc/coremx/config.json` readable only by the service identity. Keep Postfix/Rspamd spools on encrypted storage. CoreMX mail persistence uses the configured `encryptedkv` service. Add the Postfix service user to the `coremx` group for LMTP and address lookup sockets. Do not expose those sockets or the CentralFW worker interfaces externally.

Merge the supplied Postfix main/master fragments with the site's configuration. Configure Rspamd, domain DKIM keys, SMTP hostname certificates, MX/A/AAAA/PTR and SPF/DKIM/DMARC DNS records. The existing upstream gateway terminates web TLS and forwards all web traffic to CentralFW. Certificate sync/issuance is not implemented here.

The underlay supplies the `ical.js` and `sanitize-html` dependencies as well as Central's existing mail libraries. CoreMX imports Central's encryption helpers directly.

Bootstrap users and passkeys using Central's existing workflow. Sign in with a passkey, open `/coremx`, add mail domains and mailboxes, and issue separately revocable device passwords. No production services are installed or started by the composition script.

## Test

```sh
npm test
```

Gateway integration tests require local TCP/Unix sockets and a freshly built CentralFW executable. Set `CENTRALFW_TEST_BINARY` if it is not at `.cache/cargo/debug/centralfw`. Source tests load shared modules from `CENTRAL_DIR` or `../central`. Tests use local temporary fixtures and do not send internet mail. Run Central's own encryption, keychain, worker and supervisor regressions alongside CoreMX tests.

See [architecture and recovery](docs/architecture.md) for trust boundaries, encryption, journal recovery and current operational limits.
