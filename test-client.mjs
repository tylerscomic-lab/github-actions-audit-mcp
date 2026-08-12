import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'test-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8080/mcp'));
await client.connect(transport);

const tools = await client.listTools();
console.log('Tools registered:', tools.tools.map((t) => t.name));

let failures = 0;
async function audit(name, yaml, checks) {
  const r = await client.callTool({ name: 'audit_workflow', arguments: { workflow_yaml: yaml } });
  const parsed = JSON.parse(r.content[0].text);
  if (parsed.error) {
    console.log(`FAIL | ${name} | parse error: ${parsed.error}`);
    failures++;
    return parsed;
  }
  const kinds = (parsed.findings || []).map((f) => f.kind);
  let ok = true;
  for (const [kind, expected] of Object.entries(checks)) {
    const has = kinds.includes(kind);
    if (has !== expected) { ok = false; }
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | riskLevel=${parsed.riskLevel} | kinds=[${kinds.join(', ')}]`);
  if (!ok) failures++;
  return parsed;
}

console.log('\n--- clean workflow: should have NO findings of any kind ---');
await audit('clean (pinned SHA, has permissions, no injection)', `
name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@8e2d1b6a09c9b8c4e2e5a3d4c5b6a7f8e9d0c1b2
      - run: npm test
`, { unpinned_action: false, script_injection: false, missing_permissions_block: false, pull_request_target_with_head_checkout: false });

console.log('\n--- unpinned actions (tag and branch refs) ---');
await audit('unpinned tag/branch', `
name: CI
on: push
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: some-org/some-action@main
      - run: npm test
`, { unpinned_action: true });

console.log('\n--- script injection via issue comment body ---');
const inj = await audit('comment-bot injection', `
name: Comment Bot
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
jobs:
  respond:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Echo comment
        run: |
          echo "Got comment: \${{ github.event.comment.body }}"
`, { script_injection: true });
console.log('   injection finding expression:', inj.findings.find((f) => f.kind === 'script_injection')?.expression);

console.log('\n--- pull_request_target + head checkout (the dangerous combo) ---');
await audit('pr_target danger', `
name: PR Preview
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm run build
`, { pull_request_target_with_head_checkout: true, unpinned_action: true, missing_permissions_block: true });

console.log('\n--- missing permissions block entirely ---');
await audit('no permissions anywhere', `
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run deploy
`, { missing_permissions_block: true, unpinned_action: true });

console.log('\n--- safe interpolation of trusted values (github.sha, github.repository) should NOT flag injection ---');
await audit('trusted expressions only', `
name: CI
on: push
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@8e2d1b6a09c9b8c4e2e5a3d4c5b6a7f8e9d0c1b2
      - run: echo "Building \${{ github.sha }} on \${{ github.repository }}"
`, { script_injection: false });

console.log('\n--- env-var-mediated usage of untrusted input should still be readable but is a DIFFERENT (safe) pattern ---');
await audit('env-mediated (safe pattern, should NOT flag)', `
name: Comment Bot
on: issue_comment
permissions:
  contents: read
jobs:
  respond:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Echo comment safely
        env:
          COMMENT_BODY: \${{ github.event.comment.body }}
        run: echo "Got comment: $COMMENT_BODY"
`, {});

console.log('\n--- local/docker actions should not be flagged as unpinned ---');
await audit('local action reference', `
name: CI
on: push
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: ./.github/actions/my-local-action
      - run: npm test
`, { unpinned_action: false });

console.log('\n--- malformed YAML should error, not throw ---');
const bad = await client.callTool({ name: 'audit_workflow', arguments: { workflow_yaml: 'not: [valid: yaml: at: all: {{{' } });
console.log(bad.content[0].text.slice(0, 200));

console.log('\n--- check_expression_injection focused tool ---');
const focused = await client.callTool({ name: 'check_expression_injection', arguments: { run_command: 'echo "${{ github.event.pull_request.title }}"' } });
console.log(focused.content[0].text);

await client.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
