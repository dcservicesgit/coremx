# CoreMX composition and trust boundaries

CoreMX is a sparse overlay over a Central checkout. `composite_server` and `composite_portal` are disposable build outputs. Shared fixes live in Central; never patch a composed copy as the source of truth.

```
HTTPS/WSS clients → existing TLS gateway → CentralFW HTTP/WebSocket listener
                                           ↓ Unix worker sockets
                                      Central + CoreMX Node worker
                                           ↓ encryptedkv (all mail data)
Internet SMTP → Postfix → LMTP Unix socket ┘
CoreMX outbox → Postfix loopback submission → internet SMTP
```

Node has no TCP listeners. Its HTTP and WebSocket connections are outbound to CentralFW. LMTP and Postfix address lookups use local Unix sockets. Only configured upstream IPs and HTTP Host values reach the HTTP gateway. Configure the upstream to preserve Authorization and binary bodies, strip caller-supplied forwarding headers, and permit ActiveSync requests for at least 1,800 seconds. Web TLS stays upstream. SMTP certificates are supplied separately; certificate synchronisation is deferred.

CentralFW's HTTP transport version 1 uses newline-delimited JSON on a dedicated Unix socket. The worker announces `workerHello/httpVersion:1`. Request/response start, chunk, end, acknowledgement and cancellation messages carry gateway-generated request IDs. Body chunks are at most 32 KiB, frames at most 96 KiB; each direction waits for credit. Headers use pairs so repeated response headers survive. Unavailable workers produce 503; worker/protocol failures produce 502 before headers or terminate an in-progress response. The gateway does not replay mutations. Existing WebSocket worker framing is preserved.

Central's default supervisor profile remains unchanged. CoreMX selects one socket/application worker, the KV validator and CentralFW. `applicationProfile` supplies startup and controller allowlist hooks. The HTTP application serves the generated static Nuxt portal through CentralFW; no Nitro HTTP server is started.

## Encryption

All CoreMX mail data is persisted through Central's `encryptedkv` client: original MIME messages and attachments, uploaded files, mailbox records, sync state, transaction journal and commit head. CoreMX does not write mail data to filesystem blobs or journal files. `coremx.runDirectory` holds only runtime sockets and the process lock; there is no `coremx.dataDirectory` setting.

The client compresses JSON values, encrypts them using Central's AES-256-GCM envelopes and HMACs their keys. CoreMX uses the normal `get`/`set` API without plaintext indexes, raw writes or a second encryption layer. Identity and keychain handling remain owned by Central. Native mail protocols use standard TLS; they cannot use Central's proprietary browser message envelopes.

## Message and attachment storage

Original MIME messages retain their embedded attachments. Binary blobs are split into 256 KiB chunks at `coremx:v2:blobs:<blob-id>:chunk:<index>`, with an encrypted manifest at `coremx:v2:blobs:<blob-id>:manifest`. Chunks use base64 for the KV JSON interface; the existing client compresses before encryption. The manifest records object ID, size, chunk count and SHA-256. Reads validate chunk identity, exact chunk lengths and the complete checksum. A manifest is published only after all chunks are acknowledged, and mailbox references are committed afterward.

Chunk reads and writes run in batches of up to four per blob. Reading allocates one destination buffer and copies each decoded chunk into its position, avoiding a second full-message allocation from concatenation. The service still buffers complete messages for MIME parsing; end-to-end streaming and storage-level range reads are not implemented (protocol attachment ranges still load and parse the full message). The whole encoded message is limited to 32 MiB. Mailbox quota accounting uses raw message bytes, not encrypted KV size.

## Mailbox records and recovery

Each mailbox has one MailStore collection, `mailbox_<mailbox-id>`. Record keys are `coremx:v2:mailbox_<mailbox-id>:<kind>_<record-id>`. Kinds include messages, folders, outbox, hierarchy, sync, syncReplies, ping, cached Sync requests, search snapshots, preferences, upload references, calendar response history and PIM retry state. Wire IDs remain unchanged. A mailbox handle selects its collection before running predicates. Global domains, aliases, mailbox directory/quota records, device credentials and administration audit records remain shared. Collections are access/query boundaries, not separate encryption keys.

Transactions are serialized by the application worker. Each transaction writes its complete change list to `coremx:v2:journal:<sequence>`, then updates `coremx:v2:head` as its commit point, then updates the KV records and in-memory view. Journal records link to the previous record's SHA-256; the head contains the committed sequence and digest. A write error disables subsequent mutations until the store is reopened because a failed acknowledgement can still mean the write persisted. Recovery reads the committed journal from KV, verifies sequence/hash linkage and the head, and reconstructs the in-memory view and operation deduplication. It repairs only the final transaction's projections; historical records are not rewritten. Uncommitted journal tails are ignored and may be overwritten by the next transaction.

The supervisor runs one CoreMX application worker. The runtime process lock excludes another writer using the same runtime directory; it is not a distributed lock. Multiple application workers on different hosts/runtime directories must not share this namespace. No disk-store migration or legacy collection migration is performed; this layout uses the fresh `coremx:v2:` namespace.

Back up encryptedkv, runtime configuration and required encryption keys as one recoverable set. There is no separate CoreMX mail directory to back up. Preserve the encryption keys needed to read retained data. Postfix and Rspamd spool/temp files still require encrypted volumes: those external processes do not write Central envelopes. SMTP handoff can be ambiguous across a crash after downstream acceptance; exactly-once internet delivery is not promised.

Journal, sync history and unreferenced blobs currently have no compaction/garbage collection. Deleting a message does not reclaim its blob, and failed uploads may leave unpublished chunks. Filtering runs in the application against metadata reconstructed from the journal; metadata/history size affects memory and restart time. Sync commits client changes, quota adjustments, snapshots and retry responses together. It returns at most 25 server changes per collection, a total encoded-response limit of 1 MiB and a 128 KiB per-email body cap; larger bodies may be fetched with ItemOperations. Transactions retain the 3 MiB/1,000-change limit.

## Portal and protocol services

The `Webmail` service and ActiveSync share MailService, CalendarService, SearchService and PolicyService. Calendar changes and notification outbox records commit together; attendees cannot change organizer-owned meeting details. Invitations are matched by UID within the mailbox and guarded by sender/organizer/attendee identity and sequence. These checks complement SMTP authentication; they do not replace DKIM/DMARC or prove a sender's cryptographic identity.

Native HTTP data commands require a final, current policy key. Changed policies invalidate old keys and wake pending requests. Full policy acknowledgement is required; partial acknowledgement is rejected. Server-side attachment/body/age limits are applied on retrieval, while device-side restrictions rely on the client's provisioning acknowledgement. Account-only wipe is available only to known 16.1 clients and revokes that device's credential after acknowledgement. Server mailbox data is retained.

The static webmail portal calls Central's passkey-authenticated API. Every mailbox operation rechecks ownership, including administrators opening messages. HTML and attachment handling are described in [webmail.md](webmail.md). All HTTP paths continue through CentralFW.

## Current release gate

The composition, shared Central extensions, encrypted store, webmail portal and expanded ActiveSync implementation are built and tested. This is **not yet a certified production Exchange replacement**. `coremx.experimentalActiveSync` defaults to false. Enabling it advertises 14.1, 16.0 and 16.1. The [compatibility matrix](conformance.md) records supported behavior, optional extensions that return errors, resource limits and physical-device acceptance work.
