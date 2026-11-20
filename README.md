# dsh-live-teams

Host half of DSH Live Teams.

The Team tab's card geometry, type scale and interaction patterns are adapted from
[dsh-context](https://github.com/bowenliang123/dsh-context) v0.52.1 by bowenliang123,
Copyright 2025, under the Apache License 2.0; the implementation is transcribed and
modified for dsh-live-teams.


## Install

```bash
dsh plugin --profile <profile> add dsh-live-teams
```

Then enable it in that profile's `cordis.patch.yml` row (`DSH_LIVE_TEAMS=1`) and restart DSH. From a
checkout instead of the registry:

```bash
dsh plugin --profile <profile> add github:Gdenich/dsh-live-teams
```

Requirements: DSH Desktop 0.1.5-rc.1 or newer; 0.2.2-rc.1 is verified. The plugin checks the host when it mounts and turns
the team off with a readable reason if a required service is missing, so a DSH update cannot leave it
half-working. Supported releases are declared in `package.json` under `dsh.compatibility.dshReleases`.

What it does today: durable workspace-owned team state; a narrow Session port; a
deduplicating command queue; the Session-scoped context provider; tasks with attempts,
declared paths, review and acceptance; a reconciling dispatcher that starts what the lead
assigned and shows silence instead of guessing; Git-bound submissions whose review is a
commit range and whose integration is a compare-and-swap; and a human task surface in the
panel that creates, edits and releases work directly. The decisions behind each are in
`docs/decisions/` (ADR 0001–0012) and the live evidence in
`docs/implementation/pilot-findings.md`.

Mounting is opt-in through this package's Cordis patch. The row is disabled unless the
composition sets `DSH_LIVE_TEAMS=1`, and enabling it without a workspace path fails
loudly instead of running half-wired.

## Layout

TypeScript sources live in `src/`; `lib/` is the build output and is not edited by hand.
The package follows the first-party DSH conventions: ESM `lib/<entry>.js`, declarations
next to it, `exports` with `types`/`default` pairs, `files`, peer dependencies on the
Harness packages, and `dsh.bundle.patch`.

The build is unbundled on purpose: each entry is self-contained, so no hashed shared
chunk can fall outside the published `files` list, and `lib/` mirrors `src/`.

## Modules

| Module | Responsibility |
|---|---|
| `errors.ts` | Domain taxonomy, platform error translation, audit-only detail |
| `storage.ts` | Atomic publish (temp file, `fsync`, `rename`, directory `fsync`) and a process-local lock |
| `team-store.ts` | Team state under `<workspace>/.dsh-live-teams`, revision CAS, `bindingGeneration`, tolerant `events.jsonl` |
| `session-bridge.ts` | The eight-method Session port from the architecture document §9 |
| `command-queue.ts` | Durable admission, semantic deduplication, generation fencing, retry |
| `context-provider.ts` | Session-scoped membership context for `systemPrompt.context(...)` |

## Invariants enforced here

1. Member identity, Session identity, role and model route are independent values.
2. Every plugin-originated command is admitted by `command-queue` before it reaches the port.
3. Admission is idempotent on `idempotencyKey`. The platform seam is not: two `prompt`
   calls sharing one `requestId` were both accepted in the compatibility spike.
4. A command records the `bindingGeneration` it was admitted for and is refused when the
   member was rebound.
5. `interrupt` cancels a turn and never touches task attempt ownership.
6. Team context is recomputed from authoritative state on every assembly and is never cached.
7. Model selection is deliberately not implemented: the platform call also rewrites the
   deployment-wide default model, and that policy needs an explicit human decision.

## Task lifecycle controls

- Acceptance decides on submitted work and may integrate its reviewed commit. Cancellation does not accept work or imply a PASS.
- The lead can use `live_team_cancel_task` with a reason. A running attempt is fenced first; the Session must be observed stopped before archiving. An unconfirmed stop returns `quiesced: false` and `needs_human`, without an archive. Resolve the runtime problem and retry cancellation.
- `live_team_revoke_task` parks work in `draft`, optionally changing the owner after a confirmed stop. It does not automatically restart it. Contract corrections on previously started, parked work keep it parked.
- `live_team_resume_task` explicitly releases a valid parked task to `ready`. The next claim has a new attempt generation. The panel offers equivalent cancel and resume actions.
- Contract path warnings are advisory: a path may intentionally be new. An incomplete inspection is not reported as proof that a path does not exist.
- Contract `checks` are declarations; submitted results remain participant-authored claims, not system-executed test evidence. The reviewer records independent checks. No universal automatic test runner is supplied.

## Tests

```sh
pnpm --filter dsh-live-teams check
pnpm --filter dsh-live-teams build
pnpm --filter dsh-live-teams test
```

Test files cover the error taxonomy, the store, the bridge, the queue, the context
provider, and one integration file that drives the real store through the provider and
the bridge on temporary workspaces.
