# Opt-in busy headless follow-ups

This owner-maintained fork starts from pi-intercom v0.18.1. Upstream issue: https://github.com/nicobailon/pi-intercom/issues/208.

Set `headlessFollowUp: true` in your intercom config to enable this feature. The default is false. Existing interactive behaviour and default headless rejection remain unchanged. Bundled skills can remain disabled with the normal Pi package resource filter.

## Contract

- Busy headless plain sends enter Pi's native `followUp` queue, without `abort()` or a separate delivery timer. They run only after the current agent run finishes its tool work. `inboundTrigger` still applies: `never` rejects automatic follow-ups, `replies` permits only replies.
- Blocking asks get an immediate explicit rejection. They are not queued and no model answer is promised. Reply waiters still consume actual replies normally.
- Pending native entries are bounded at 32 messages and 256 KiB of message text/attachments per receiver. Overflow is rejected. IDs dedupe through the existing broker and receiver guards; ordered sends follow native queue order.
- Native queue acceptance is `queued`, not `injected`. A receiver emits `injected` only when a context hook observes that exact custom-message ID. This proves provider-context inclusion, not model processing or obedience. Peer messages remain peer messages, never owner authority.
- New opted-in senders observe the existing broker's receipt stream before accepting transport completion. The model-facing result and CLI explicitly distinguish accepted/queued (`delivered: false`, `injected: false`) from context injection. Missing receipts report unknown, never injection success. `intercom status` includes the latest ten outbound receipts.
- Clean receiver shutdown expires pending IDs. A connected opted-in sender observing a queued receiver's disconnect reports expiry/unconfirmed injection; a broker or sender disconnect likewise ends observation as unconfirmed. There is no durable replay or exactly-once claim across crashes. A CLI that has already exited reports only its initial queued state, not a later outcome.
- Pi's public API cannot withdraw a native follow-up. Cancellation or supersede after hand-off is reported as `cancellation_requested`, and the message may still be injected. Before hand-off, upstream held-queue cancellation still works. Pending entries have no private expiry timer: they wait with the current run, bounded by the receiver's queue limit.

## Compatibility and installation

No broker restart is required. The fork observes the existing 0.18.1 `message_receipt` and `session_left` events; it does not change their protocol. New clients can share an already-running upstream broker and old clients. **Old sender tabs retain upstream's transport-only reporting until deliberately reloaded.** Installing a package does not update code already loaded by an existing process.

Install an immutable commit of `skeaney1/pi-intercom` with Pi's git package source, and exclude the previous npm package to avoid double registration. External CLI wrappers must resolve `cli.mjs` in the configured git package rather than assuming the old npm directory.

## Checks

`npm test` runs the upstream suite and added policy/receipt/FIFO/dedupe/queue-limit/shutdown tests. `node reproduce.mjs --queue-test` runs two actual Pi processes and a deterministic scripted provider, asserting that the original request completes before the nonce appears once in a follow-up and session history. This is a transport/lifecycle test, not an LLM benchmark. `PI_BOLT_BINARY`, `INTERCOM_PACKAGE` and `INTERCOM_EVIDENCE_DIR` allow explicit executable, package and evidence locations for platform checks.

Undo: restore the previous pinned npm package/config and check a fresh Pi start. Existing tabs are not restarted automatically.
