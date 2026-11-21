# dsh-live-teams

**A durable team of long-lived DSH Sessions — with owned tasks, independent review, and a human in control.**

`dsh-live-teams` turns DeepSeek Harness into a small working team. Each member is a real, persistent
DSH Session with a name, a role, and its own working context. Work is tracked as durable tasks; a
designated reviewer decides on an immutable submission; the lead and the human keep authority over
assignment, cancellation, and acceptance.

Unlike one-shot subagents, members keep their Session and role across tasks and restarts. Unlike a
chat-only workflow, every task, attempt, submission, and verdict survives a crash and can be
inspected later.

```text
DSH Desktop
├── Team tab ──────────────── tasks · members · activity
├── Lead / Builder / Reviewer Sessions
└── .dsh-live-teams/ ─────── team, tasks, attempts, submissions, reviews, mailbox
```

## Why this exists

A single coding agent is easy to start and hard to supervise. Once several agents work in parallel,
the important questions stop being "what code did it write?" and become:

- **Who owns this task, and who is allowed to accept it?**
- **What exactly was submitted, and what did the reviewer check?**
- **What happens to the work if a Session dies, a binding changes, or the app restarts?**
- **How does the human pause, correct, or stop the team without losing the audit trail?**

`dsh-live-teams` makes those questions part of the data model instead of leaving them to prompts and
chat messages.

## What you get

### Persistent members

A member is a long-lived DSH Session, not a temporary worker. It has a member id, display name, role,
availability, contact grants, and a binding generation. The human can open its Session directly and
talk to it; the lead can assign it work. Roles ship as editable Markdown files under `roles/`
(Lead, Builder, Reviewer, Verifier, Scout, Researcher, Oracle, Delegate).

### Durable tasks

Tasks live under `<workspace>/.dsh-live-teams` and move through an explicit lifecycle: `draft`,
`ready`, `claimed`, `in_progress`, `waiting`, `needs_human`, `completed`, `cancelled`. A task carries
its contract: title, acceptance criteria, declared paths, dependencies, route, round limit, and human
contact policy. Every attempt is recorded; a revision conflict is refused instead of silently
overwriting another agent's work.

### Independent review

A task can route to a named reviewer or report back to the lead. A submission is immutable: the
reviewer decides on exactly that submission, with findings and recorded evidence. The current
assignee cannot review their own work. A PASS completes the task; `needs_revision` returns it for
another round; `escalate` asks the lead for a decision. Round limits stop an endless review loop.

### Git-bound submissions

In a Git workspace, a submission is a commit built by the plugin from the paths the member declared,
not "whatever happened to be in the folder". Review is a commit range, integration is a
compare-and-swap against the base the work started from, and overlapping declared paths are
serialized before two writers can conflict. In non-Git folders the same lifecycle works from a tree
fingerprint.

### Reliable delivery

Messages and task handoffs go through a durable mailbox and command queue. Requests are deduplicated
by idempotency key, fenced by the member's binding generation, retried when a Session is temporarily
unavailable, and recovered after a restart. The team shows silence instead of pretending a message
was delivered.

### A Team tab built for supervision

The Team tab shows the active task queue, waiting and archived work, the member roster, and the
activity journal. Members can be added from an existing Session or created in the workspace; roles,
availability, names, and contact grants are editable. Dispatch can be paused. Tasks can be
created, claimed, released, revised, revoked, resumed, cancelled, and accepted from the panel.

### Human and lead authority

The human controls team composition and can intervene in any Session. The lead coordinates members
and is the default authority for acceptance and escalation. Contact between members is granted, not
implicit; the human is reached directly or through the lead. There is no hidden autonomous loop:
dispatch is visible, pausable, and coding dispatch is opt-in.

## Quick start

### Install

```bash
dsh plugin --profile <profile> add dsh-live-teams
```

Or install from GitHub:

```bash
dsh plugin --profile <profile> add github:Gdenich/dsh-live-teams
```

The package's Cordis patch inserts the row **disabled**. Installing the package must not start team
coordination by itself. Enable it in the profile, after the bundle layers:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: live-teams
  disabled: false
  config:
    enabled: true
    # optional:
    # workspacePath: /absolute/path/to/your/project
    # codingDispatch: automatic
```

Then restart DSH. The profile layer is applied after every bundle layer; this override is enough.
Do not copy the package's own `insert` row into the profile.

Without `workspacePath`, the team is resolved from each Session's cwd, so one profile can serve
several workspaces. With it, the profile is pinned to one workspace.

If you launch DSH from a terminal, the package row also accepts environment variables:
`DSH_LIVE_TEAMS=1`, `DSH_LIVE_TEAMS_WORKSPACE`, `DSH_LIVE_TEAMS_TEAM_NAME`,
`DSH_LIVE_TEAMS_CODING`, and `DSH_LIVE_TEAMS_SCOPE_MODE`. A Desktop app launched from Finder does
not inherit shell exports; use the profile row there.

Open the workspace in DSH Desktop and select the **Team** tab.

### First task

1. Add at least a Lead and a Builder. A member can reuse an existing Session in this workspace or
   create a new one.
2. Create a task, assign it, give it acceptance criteria and declared paths, and route it to a
   reviewer.
3. The dispatcher starts the assigned work; the builder claims and acknowledges the task, does the
   work, and submits an artifact.
4. The reviewer records findings and evidence, then passes the submission or requests a revision.
5. The lead or human can accept, cancel, revoke, or resume work from the panel at any point.

## Configuration

| Profile key | Environment | Meaning | Default |
|---|---|---|---|
| `enabled` | `DSH_LIVE_TEAMS` | Enables the plugin row | `false` |
| `workspacePath` | `DSH_LIVE_TEAMS_WORKSPACE` | Absolute workspace path pinned to this team | Session cwd |
| `workspaceId` | `DSH_LIVE_TEAMS_WORKSPACE_ID` | Workspace id, when the workspace is already registered | derived |
| `teamId` | `DSH_LIVE_TEAMS_TEAM_ID` | Stable team id | derived from the workspace |
| `teamName` | `DSH_LIVE_TEAMS_TEAM_NAME` | Display name | workspace name |
| `codingDispatch` | `DSH_LIVE_TEAMS_CODING` | `automatic` allows the dispatcher to start coding tasks; `manual` only starts non-coding work | `manual` |
| `scopeMode` | `DSH_LIVE_TEAMS_SCOPE_MODE` | `auto`, `git`, or `files` — how changed paths are observed | `auto` |

Team state, tasks, submissions, reviews, and the activity journal are stored under
`<workspace>/.dsh-live-teams`. Do not edit those files by hand: the plugin validates and locks them.

## Compatibility

- DSH Desktop **0.1.5-rc.1 or newer**.
- **0.2.2-rc.1 is verified** with the native checks B37, B38, B41, and B42.
- The plugin checks the host at mount and reports the result in its status, so an incompatible host
  is visible before work starts instead of failing one action at a time.
- Sessions routed through the Claude Code MCP bridge receive the matching `mcp__dsh__live_team_*`
  tool names; the bridge itself is a separate package.

## Security model

`dsh-live-teams` is a coordination layer, not a sandbox. Members are ordinary DSH Sessions and run
with the permissions the deployment gives them. The plugin enforces team authority, task ownership,
review routes, contact grants, and binding fences; it does not promise that a member cannot read or
write something its Session is otherwise allowed to touch.

Use it in trusted workspaces. If you need stronger isolation between coding agents, provide it at the
DSH deployment or workspace level; the plugin does not fake it.

## Current limitations

- One team per workspace; the state directory is the unit of ownership.
- Members share the workspace. There is no built-in worktree-per-task isolation.
- Coding dispatch is **manual by default**. Setting `DSH_LIVE_TEAMS_CODING=automatic` accepts the
  shared-tree risk for this deployment.
- Task `checks` are declarations, not a universal test runner. The reviewer is expected to run and
  record independent checks; a submitted claim is not system proof.
- Model selection is intentionally not exposed: changing it at this layer would also rewrite the
  deployment-wide default model.
- The project is early. Storage formats and tool schemas may change between releases; keep the
  workspace state under version control or back it up.

## Development

```bash
pnpm --filter dsh-live-teams check   # host and client types
pnpm --filter dsh-live-teams test    # 753 tests
pnpm --filter dsh-live-teams build   # host, client, declarations
```

Native host-composition checks live in the development tree rather than in the published package;
they boot an installed DSH Desktop with a disposable workspace and are run one check at a time.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
