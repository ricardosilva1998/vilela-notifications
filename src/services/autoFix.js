const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const config = require('../config');
const db = require('../db');

const REPO_ROOT = path.join(__dirname, '..', '..');

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function getRepoInfo() {
  if (config.github.repo) return config.github.repo;
  try {
    const remote = execSync('git remote get-url origin', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const sshMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = remote.match(/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch (e) {}
  throw new Error('Could not determine GitHub repo — set GITHUB_REPO env var');
}

function applyPatch(patch) {
  const backups = [];

  for (const entry of patch) {
    const filePath = path.join(REPO_ROOT, entry.file);
    if (!fs.existsSync(filePath)) {
      for (const b of backups) fs.writeFileSync(b.path, b.content);
      throw new Error(`File not found: ${entry.file}`);
    }

    const original = fs.readFileSync(filePath, 'utf8');
    if (!original.includes(entry.old)) {
      for (const b of backups) fs.writeFileSync(b.path, b.content);
      throw new Error(`Patch string not found in ${entry.file} — code may have changed since analysis`);
    }

    backups.push({ path: filePath, content: original });
    const patched = original.replace(entry.old, entry.new);
    fs.writeFileSync(filePath, patched);
  }

  return backups;
}

function rollback(backups) {
  for (const b of backups) {
    fs.writeFileSync(b.path, b.content);
  }
}

function githubApi(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const repo = getRepoInfo();
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repo}${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${config.github.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'atleta-autofix',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
        }
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fixIssue(issueId) {
  const issue = db.getIssueById(issueId);
  if (!issue) throw new Error('Issue not found');
  if (!issue.agent_analysis) throw new Error('No AI analysis available');

  const analysis = JSON.parse(issue.agent_analysis);
  if (!analysis.can_fix || !analysis.patch || analysis.patch.length === 0) {
    throw new Error('AI analysis indicates this issue cannot be auto-fixed');
  }

  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN not configured');
  }

  const branchName = `fix/issue-${issueId}-${slugify(issue.subject)}`;
  const mainBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  console.log(`[AutoFix] Applying patch for issue #${issueId} on branch ${branchName}`);

  const backups = applyPatch(analysis.patch);

  try {
    execSync(`git checkout -b ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    const changedFiles = analysis.patch.map(p => p.file).join(' ');
    execSync(`git add ${changedFiles}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    execSync(`git commit -m "fix: ${issue.subject} (auto-fix from issue #${issueId})"`, { cwd: REPO_ROOT, encoding: 'utf8' });
    execSync(`git push origin ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });

    const pr = await githubApi('POST', '/pulls', {
      title: `fix: ${issue.subject} (auto-fix #${issueId})`,
      body: `## Auto-Fix for Issue #${issueId}\n\n**Problem:** ${analysis.summary}\n\n**Root Cause:** ${analysis.root_cause}\n\n**Confidence:** ${analysis.confidence}\n\n**Notes:** ${analysis.notes || 'None'}\n\n---\n_This PR was generated automatically by the Atleta AI Agent Triage system._`,
      head: branchName,
      base: mainBranch,
    });

    execSync(`git checkout ${mainBranch}`, { cwd: REPO_ROOT, encoding: 'utf8' });

    db.updateIssueStatus(issueId, 'in_progress', `Auto-fix PR created: ${pr.html_url}`);
    console.log(`[AutoFix] PR created for issue #${issueId}: ${pr.html_url}`);

    return { ok: true, pr_url: pr.html_url, branch: branchName };
  } catch (err) {
    rollback(backups);
    try {
      execSync(`git checkout ${mainBranch}`, { cwd: REPO_ROOT, encoding: 'utf8' });
      execSync(`git branch -D ${branchName}`, { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch (e) {}
    throw err;
  }
}

module.exports = { fixIssue };
