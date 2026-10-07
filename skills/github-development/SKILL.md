---
name: github-development
description: Clone, change, test and open pull requests using host-managed GitHub access.
---

# GitHub development
Use github_clone, github_push and github_create_pull_request through call_tool.
These tools use the owner's GitHub connection. Never ask for credentials in chat,
put tokens in commands, or use browser sign-in to bypass a missing connection.
1. Confirm the requested repository and task from the conversation. Use github_connect
   with write access for a development/PR task or read for inspection. Clone into a
   relative workspace path. A connection request pauses this run; continue after
   the host confirms access. An existing working tree must be inspected, not erased.
2. Read AGENTS.md and project instructions. Inspect git status and preserve local
   work. Create a named branch, implement the task, and run relevant project checks.
3. Review the diff, commit only intended files, and use github_push for that branch.
   Git identity can be set locally to Timber Bot <timber@users.noreply.github.com>.
4. Find existing PRs before creating one. Give the PR a clear description of the
   problem, changes and actual verification. Never claim a check passed without evidence.
5. Report the PR URL and test outcome in a final response. Every tool completion
   needs an assistant follow-up; don't leave the user with only command logs.
The workspace checkpoint limit is 256 MiB and 10,000 entries, including .git.
Use shallow clones when appropriate; dependencies/caches are not durable. A failed
checkpoint means the working tree is not yet durable; don't rerun completed effects.
Connection authorization covers the requested repository scope; skills grant no access.
Do not merge or force-push unless explicitly requested.
