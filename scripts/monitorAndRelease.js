const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs').promises;

// External repository details
const EXTERNAL_REPO_OWNER = 'aayush2622';
const EXTERNAL_REPO = 'Dartotsu';
const YOUR_REPO = 'itsmechinmoy/dartotsu-updater';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// URLs
const COMMITS_URL = `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commits`;
const WORKFLOW_URL = `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/actions/workflows/dart.yml/runs`;

// Headers for GitHub API
const headers = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
};

// File to store the last processed commit SHA
const LAST_PROCESSED_FILE = 'last_processed_commit.txt';

// Get latest commits from external repository
async function getExternalRepoCommits() {
  try {
    const response = await axios.get(COMMITS_URL, { headers });
    return response.data;
  } catch (error) {
    console.error('Error fetching commits:', error.message);
    return [];
  }
}

// Check if any commit matches the build pattern
function getBuildTypeAndSha(commits) {
  for (const commit of commits) {
    const message = commit.commit.message;
    const sha = commit.sha;
    if (message.includes('[build.all]')) return { buildType: 'build.all', sha };
    if (message.includes('[build.apk]')) return { buildType: 'build.apk', sha };
    if (message.includes('[build.windows]')) return { buildType: 'build.windows', sha };
    if (message.includes('[build.linux]')) return { buildType: 'build.linux', sha };
    if (message.includes('[build.ios]')) return { buildType: 'build.ios', sha };
    if (message.includes('[build.macos]')) return { buildType: 'build.macos', sha };
  }
  return null;
}

// Get workflow runs for a specific commit SHA
async function getWorkflowStatusForCommit(sha) {
  try {
    const response = await axios.get(`${WORKFLOW_URL}?head_sha=${sha}`, { headers });
    const runs = response.data.workflow_runs;
    if (runs.length === 0) {
      console.log(`No workflow runs found for commit ${sha}`);
      return null;
    }
    const latestRun = runs[0]; // Latest run for this commit
    return {
      status: latestRun.status,
      conclusion: latestRun.conclusion,
      updated_at: latestRun.updated_at,
    };
  } catch (error) {
    console.error('Error fetching workflow status:', error.message);
    return null;
  }
}

// Wait for workflow to complete
async function waitForWorkflowCompletion(sha) {
  const maxAttempts = 60; // Wait up to 30 minutes (60 * 30s)
  let attempts = 0;

  while (attempts < maxAttempts) {
    const workflow = await getWorkflowStatusForCommit(sha);
    if (!workflow) {
      console.error(`Failed to fetch workflow status for commit ${sha}.`);
      return false;
    }

    if (workflow.status === 'completed') {
      if (workflow.conclusion === 'success') {
        console.log(`Workflow for commit ${sha} completed successfully.`);
        return true;
      } else {
        console.log(`Workflow for commit ${sha} failed with conclusion: ${workflow.conclusion}`);
        return false;
      }
    }

    console.log(`Workflow for commit ${sha} still running, waiting 30 seconds...`);
    await new Promise(resolve => setTimeout(resolve, 30000));
    attempts++;
  }

  console.error(`Workflow for commit ${sha} did not complete in time.`);
  return false;
}

// Read last processed commit SHA
async function readLastProcessedCommit() {
  try {
    return await fs.readFile(LAST_PROCESSED_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No last processed commit file found, starting fresh.');
      return null;
    }
    console.error('Error reading last processed commit:', error.message);
    return null;
  }
}

// Write last processed commit SHA
async function writeLastProcessedCommit(sha) {
  try {
    await fs.writeFile(LAST_PROCESSED_FILE, sha);
    console.log(`Updated last processed commit to ${sha}`);
  } catch (error) {
    console.error('Error writing last processed commit:', error.message);
  }
}

// Trigger Python script to download and release
function triggerDownloadAndRelease(buildType) {
  try {
    execSync(`python download_and_release.py '${process.env.SERVICE_ACCOUNT_JSON}' ${buildType}`, { stdio: 'inherit' });
    console.log('Download and release script executed successfully.');
  } catch (error) {
    console.error('Error executing download and release script:', error.message);
  }
}

// Main function
async function main() {
  // Read last processed commit
  const lastProcessedSha = await readLastProcessedCommit();

  // Get commits
  const commits = await getExternalRepoCommits();
  const buildInfo = getBuildTypeAndSha(commits);

  if (!buildInfo) {
    console.log('No matching build commit found.');
    return;
  }

  const { buildType, sha } = buildInfo;
  console.log(`Detected ${buildType} commit with SHA ${sha}.`);

  // Check if this commit was already processed
  if (sha === lastProcessedSha) {
    console.log(`Commit ${sha} was already processed, skipping.`);
    return;
  }

  // Wait for workflow to complete for this specific commit
  const workflowSuccess = await waitForWorkflowCompletion(sha);
  if (!workflowSuccess) {
    console.error(`Workflow for commit ${sha} did not succeed, skipping release.`);
    return;
  }

  // Trigger download and release
  triggerDownloadAndRelease(buildType);

  // Update last processed commit
  await writeLastProcessedCommit(sha);
}

main();
