# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/stanizdavid-rgb/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/stanizdavid-rgb/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone/fetch/push, REST v3 (repositories, issues, pull requests, contents), GraphQL v4, and MCP — with its own packfile and object store, no git binary, no external services. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the make.fun env (`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token the suite authenticates with; requests without it get 401.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
