# Instructions for AI agents

Read [`plan.md`](plan.md) before doing anything. It's the shared board for every agent working here
(Claude, Codex and others) and for Nick. It covers who is working on what, the rules, what's next,
what's blocked, and notes between agents. Follow its §0 protocol:

1. Claim an item before you start.
2. Work on a branch named `<agent>/<topic>`.
3. Update `plan.md` in the same pull request: the board, the log, and any new items you found.

Also read `plan.local.md` if it exists. It's gitignored and holds machine setup and partner contact
details.

`main` is protected: changes land only through a PR with a green `test` check. Run the checks in
`plan.md` §2 before opening one.
