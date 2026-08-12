import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── Minimal block-YAML parser, scoped to what GitHub Actions workflow files
// actually use (2-space block mappings/sequences, plain/quoted scalars,
// comments, block scalars |/>). Not a general YAML implementation — flow
// collections ([a,b], {a:b}) are captured as raw strings, which is fine here
// since none of the checks below need to descend into them. This mirrors the
// portfolio's existing pattern (regex-safety-audit-mcp hand-writes its own
// AST rather than pulling in a parsing library) and keeps the dependency
// surface at just the MCP SDK + zod.

function stripComment(line) {
  // Only strip a # that starts a comment (preceded by whitespace or at line
  // start, not inside a quoted string) -- good enough for workflow YAML,
  // which rarely puts a literal # inside an unquoted scalar.
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function indentOf(line) {
  const m = /^ */.exec(line);
  return m[0].length;
}

// Parses a block of lines (already comment-stripped, blank-stripped) starting
// at `start` with a given minimum indent into a JS value (object/array/scalar),
// returning { value, next } where `next` is the index of the first line not
// consumed. Each parsed node also carries a hidden __line (1-based source
// line number) via a non-enumerable property, used to report findings at
// their real source location.
function parseBlock(lines, start, indent) {
  if (start >= lines.length) return { value: null, next: start };
  const first = lines[start];
  if (indentOf(first.text) < indent) return { value: null, next: start };

  const isSeq = /^-(\s|$)/.test(first.text.slice(indent));
  if (isSeq) {
    const arr = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (indentOf(line.text) < indent) break;
      if (indentOf(line.text) > indent) { i++; continue; } // shouldn't happen if caller sliced right
      const rest = line.text.slice(indent);
      if (!/^-(\s|$)/.test(rest)) break;
      const afterDash = rest.slice(1).replace(/^\s*/, '');
      const dashIndent = indent + (rest.length - rest.replace(/^-\s*/, '').length);
      if (afterDash === '') {
        const { value, next } = parseBlock(lines, i + 1, indent + 2);
        Object.defineProperty(Object(value), '__line', { value: line.n, enumerable: false, configurable: true });
        arr.push(value);
        i = next;
      } else if (/^[^:\s][^:]*:\s*($|.+)/.test(afterDash) && !looksLikeInlineScalar(afterDash)) {
        // inline mapping start, e.g. "- name: foo"
        const fakeLine = { text: ' '.repeat(dashIndent) + afterDash, n: line.n };
        const rest2 = lines.slice(i + 1).filter((l) => indentOf(l.text) >= dashIndent);
        const { value } = parseBlock([fakeLine, ...lines.slice(i + 1)], 0, dashIndent);
        arr.push(value);
        // find how many lines were consumed: everything indented >= dashIndent starting at i+1's block, plus the dash line itself
        let j = i + 1;
        while (j < lines.length && (indentOf(lines[j].text) > indent || (indentOf(lines[j].text) === indent && !/^-(\s|$)/.test(lines[j].text.slice(indent))))) j++;
        i = j;
      } else {
        arr.push(scalarValue(afterDash));
        i++;
      }
    }
    return { value: arr, next: i };
  }

  const obj = {};
  Object.defineProperty(obj, '__lines', { value: {}, enumerable: false, configurable: true });
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line.text) !== indent) break;
    const text = line.text.slice(indent);
    const m = /^([^:\s][^:]*?):(\s+(.*)|)$/.exec(text) || /^"([^"]*)":(\s+(.*)|)$/.exec(text) || /^'([^']*)':(\s+(.*)|)$/.exec(text);
    if (!m) { i++; continue; }
    const key = unquote(m[1]);
    const valText = (m[3] || '').trim();
    obj.__lines[key] = line.n;
    if (valText === '' ) {
      const { value, next } = parseBlock(lines, i + 1, indent + 2 <= (lines[i + 1] ? indentOf(lines[i + 1].text) : indent + 2) ? nextIndent(lines, i + 1, indent) : indent + 2);
      obj[key] = value === null ? '' : value;
      i = next;
    } else if (valText === '|' || valText === '>' || valText.startsWith('|') || valText.startsWith('>')) {
      const blockIndent = lines[i + 1] ? indentOf(lines[i + 1].text) : indent + 2;
      let text2 = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].text.trim() === '' || indentOf(lines[j].text) >= blockIndent)) {
        text2.push(lines[j].text.slice(blockIndent));
        j++;
      }
      obj[key] = text2.join('\n');
      i = j;
    } else {
      obj[key] = scalarValue(valText);
      i++;
    }
  }
  return { value: obj, next: i };
}

function nextIndent(lines, i, parentIndent) {
  for (let j = i; j < lines.length; j++) {
    if (lines[j].text.trim() === '') continue;
    const ind = indentOf(lines[j].text);
    return ind > parentIndent ? ind : parentIndent + 2;
  }
  return parentIndent + 2;
}

function looksLikeInlineScalar(s) {
  return /^https?:\/\//.test(s) || /^\$\{\{/.test(s);
}

function scalarValue(s) {
  s = unquote(s.trim());
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

function parseYaml(src) {
  const rawLines = src.split(/\r?\n/);
  const lines = [];
  rawLines.forEach((text, idx) => {
    const stripped = stripComment(text).replace(/\s+$/, '');
    if (stripped.trim() === '') return;
    if (/^---\s*$/.test(stripped)) return;
    lines.push({ text: stripped, n: idx + 1 });
  });
  if (!lines.length) return { value: {}, next: 0 };
  const baseIndent = indentOf(lines[0].text);
  const { value } = parseBlock(lines, 0, baseIndent);
  return value;
}

// ── Checks ───────────────────────────────────────────────────────────────

// GitHub's own documented list of event-context expressions that carry
// attacker-controlled text on at least some trigger types (issue/PR titles,
// bodies, comments, branch/tag/commit names, review text). Interpolating any
// of these directly into a `run:` shell step is the #1 real-world GitHub
// Actions vulnerability class -- the expression is substituted into the
// generated shell script BEFORE the shell ever runs, so it's not a variable,
// it's literal attacker-controlled shell syntax.
const UNTRUSTED_EXPRESSIONS = [
  'github.event.issue.title', 'github.event.issue.body',
  'github.event.pull_request.title', 'github.event.pull_request.body',
  'github.event.comment.body', 'github.event.review.body',
  'github.event.review_comment.body', 'github.event.pages.*.page_name',
  'github.event.commits.*.message', 'github.event.head_commit.message',
  'github.head_ref', 'github.event.pull_request.head.ref',
  'github.event.pull_request.head.repo.default_branch',
  'github.event.discussion.title', 'github.event.discussion.body',
];

function findInjectionRisks(workflow, findings) {
  walkRunSteps(workflow, (runText, path) => {
    if (typeof runText !== 'string') return;
    const exprRe = /\$\{\{\s*([^}]+?)\s*\}\}/g;
    let m;
    while ((m = exprRe.exec(runText))) {
      const expr = m[1].trim();
      const matchedUntrusted = UNTRUSTED_EXPRESSIONS.find((u) => {
        if (u.includes('*')) return new RegExp('^' + u.replace(/\./g, '\\.').replace('\\*', '[^.]+') + '$').test(expr);
        return expr === u || expr.startsWith(u + '.') || expr.startsWith(u + '[');
      });
      if (matchedUntrusted) {
        findings.push({
          severity: 'critical', kind: 'script_injection',
          location: path,
          expression: `\${{ ${expr} }}`,
          why: `This expression's value comes from event content an attacker directly controls (${matchedUntrusted}) and is substituted into the shell script text before the shell runs it -- it is not passed as a variable, so \`"; rm -rf . #\` in a PR title or issue comment becomes literal shell syntax. This is the single most common real-world GitHub Actions vulnerability.`,
          fix: `Pass it through an environment variable instead, which the shell DOES treat as data, not code: add \`env:\\n  UNTRUSTED_VALUE: \${{ ${expr} }}\` to the step, then reference it in the script as \`"$UNTRUSTED_VALUE"\` (with quotes) instead of the \${{ }} expression directly.`,
        });
      }
    }
  }, []);
}

function walkRunSteps(node, cb, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkRunSteps(item, cb, [...path, String(i)]));
    return;
  }
  if (typeof node.run === 'string') cb(node.run, [...path, 'run'].join('.'));
  for (const [k, v] of Object.entries(node)) {
    if (k === '__lines') continue;
    walkRunSteps(v, cb, [...path, k]);
  }
}

// A `uses:` ref pinned to anything other than a full 40-char commit SHA can
// be repointed by whoever controls that tag/branch after review -- the
// tj-actions/changed-files compromise (a maintainer's PAT was used to
// retag `v35`...`v46` to point at a credential-harvesting commit,
// March 2025) is the canonical real-world example of exactly this.
function findUnpinnedActions(workflow, findings) {
  walkRunSteps2(workflow, (usesText, path) => {
    if (typeof usesText !== 'string') return;
    if (usesText.startsWith('./') || usesText.startsWith('docker://')) return; // local/docker actions, different trust model
    const m = /^([^@]+)@(.+)$/.exec(usesText);
    if (!m) {
      findings.push({ severity: 'warning', kind: 'unpinned_action', location: path, action: usesText, why: 'No @ref at all -- this action has no pinned version, so it always runs whatever is on the default branch right now.', fix: 'Pin to a full 40-character commit SHA, e.g. actions/checkout@8e2d..40hex..dc.' });
      return;
    }
    const [, name, ref] = m;
    const isFullSha = /^[0-9a-f]{40}$/i.test(ref);
    if (!isFullSha) {
      const refKind = /^v?\d+(\.\d+)*$/.test(ref) ? 'a version tag' : /^[0-9a-f]{7,39}$/i.test(ref) ? 'a short/abbreviated SHA (not collision-proof and still mutable if force-pushed)' : 'a branch name (moves on every push to it)';
      findings.push({
        severity: name.startsWith('./') ? 'info' : 'warning', kind: 'unpinned_action', location: path, action: usesText,
        why: `Pinned to ${refKind}, not a full commit SHA -- whoever controls that ref in ${name} can change what code actually runs here without you changing a single character in this file.`,
        fix: `Resolve ${name}@${ref} to its current commit and pin that instead: uses: ${name}@<40-char-sha> # ${ref}`,
      });
    }
  }, []);
}

function walkRunSteps2(node, cb, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item, i) => walkRunSteps2(item, cb, [...path, String(i)])); return; }
  if (typeof node.uses === 'string') cb(node.uses, [...path, 'uses'].join('.'));
  for (const [k, v] of Object.entries(node)) { if (k !== '__lines') walkRunSteps2(v, cb, [...path, k]); }
}

function findPermissionsGap(workflow, findings) {
  const hasTopLevel = Object.prototype.hasOwnProperty.call(workflow, 'permissions');
  if (!hasTopLevel) {
    const jobs = workflow.jobs || {};
    const jobsWithoutPerms = Object.entries(jobs).filter(([, job]) => !job || !Object.prototype.hasOwnProperty.call(job, 'permissions'));
    if (jobsWithoutPerms.length) {
      findings.push({
        severity: 'warning', kind: 'missing_permissions_block', location: 'permissions',
        why: `No top-level "permissions:" block, and ${jobsWithoutPerms.length} job(s) (${jobsWithoutPerms.map(([n]) => n).join(', ')}) don't set their own either -- the GITHUB_TOKEN for those jobs defaults to whatever your repository/org setting allows, which is read-write on many repos. If a step in this workflow is ever compromised (a malicious dependency, a supply-chain-compromised action), it inherits that full default scope.`,
        fix: 'Add a top-level `permissions: { contents: read }` (or per-job) and only elevate the specific scope a job actually needs, e.g. `pull-requests: write` for a job that comments on PRs.',
      });
    }
  }
}

function findDangerousPullRequestTarget(workflow, findings) {
  const on = workflow.on;
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  if (!triggers.includes('pull_request_target')) return;
  let checksOutHeadRef = false;
  walkRunSteps2(workflow, () => {}, []); // no-op, keeps walker import pattern consistent
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.uses && /actions\/checkout/.test(node.uses) && node.with && typeof node.with.ref === 'string' && /pull_request\.head/.test(node.with.ref)) {
      checksOutHeadRef = true;
    }
    for (const [k, v] of Object.entries(node)) if (k !== '__lines') walk(v);
  })(workflow);
  if (checksOutHeadRef) {
    findings.push({
      severity: 'critical', kind: 'pull_request_target_with_head_checkout', location: 'on.pull_request_target',
      why: 'This workflow triggers on pull_request_target (which runs with the BASE repo\'s secrets and a write-scoped token, unlike plain pull_request) AND explicitly checks out the PR\'s own head commit. That combination lets a pull request from any fork run its own arbitrary code with your repo\'s secrets -- this is the exact pattern behind several real npm/PyPI supply-chain incidents.',
      fix: 'Either switch the trigger to plain `pull_request` (no secrets, read-only token, but can\'t comment/label with elevated permissions), or if pull_request_target is genuinely needed, never check out `github.event.pull_request.head.sha`/`.ref` -- only build/test against the base ref, and if you must run PR code, do it in a separate job with no secrets and require manual approval (environment protection rules) before any privileged step.',
    });
  }
}

function auditWorkflow(yamlSrc) {
  let workflow;
  try {
    workflow = parseYaml(yamlSrc);
  } catch (e) {
    return { error: `Could not parse workflow YAML: ${e.message}` };
  }
  if (!workflow || typeof workflow !== 'object') {
    return { error: 'Parsed content is not a YAML mapping -- is this really a GitHub Actions workflow file?' };
  }
  const findings = [];
  findInjectionRisks(workflow, findings);
  findUnpinnedActions(workflow, findings);
  findPermissionsGap(workflow, findings);
  findDangerousPullRequestTarget(workflow, findings);

  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  return {
    riskLevel: critical > 0 ? 'HIGH — exploitable pattern found' : warning > 0 ? 'MODERATE — hardening gaps found' : 'LOW — no known dangerous patterns found',
    findingCount: findings.length,
    criticalCount: critical,
    warningCount: warning,
    findings,
  };
}

function buildServer() {
  const server = new McpServer({ name: 'github-actions-audit-mcp', version: '1.0.0' });

  server.tool('audit_workflow',
    'Audits a GitHub Actions workflow YAML file for the real, documented vulnerability classes that have caused actual incidents: script injection via untrusted event-context expressions (issue/PR titles, comments) interpolated directly into `run:` shell steps; third-party actions pinned to a mutable tag/branch instead of a commit SHA (the tj-actions/changed-files supply-chain attack pattern); a missing or overly-broad `permissions:` block; and pull_request_target combined with checking out the PR\'s own head commit (lets a fork\'s PR run arbitrary code with your secrets). Parses real YAML structure, not string matching.',
    { workflow_yaml: z.string().describe('The full contents of a .github/workflows/*.yml file') },
    async ({ workflow_yaml }) => ({ content: [{ type: 'text', text: JSON.stringify(auditWorkflow(workflow_yaml), null, 2) }] })
  );

  server.tool('check_expression_injection',
    'Focused check: scans a single shell command string (as it would appear in a `run:` step) for GitHub Actions expression syntax (${{ ... }}) referencing event-context fields that carry attacker-controlled text, and explains the env-variable fix. Useful for checking a snippet without a full workflow file.',
    { run_command: z.string().describe('The shell command text from a run: step') },
    async ({ run_command }) => {
      const findings = [];
      findInjectionRisks({ __probe: { run: run_command } }, findings);
      return { content: [{ type: 'text', text: JSON.stringify({ safe: findings.length === 0, findings }, null, 2) }] };
    }
  );

  return server;
}

// ── HTTP server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url !== '/' && !req.url?.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => console.log(`github-actions-audit-mcp listening on :${PORT}`));
