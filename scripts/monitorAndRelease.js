const axios = require('axios');
const { execSync } = require('child_process');

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
function getBuildType(commits) {
  for (const commit of commits) {
    const message = commit.commit.message;
    if (message.includes('[build.all]')) return 'build.all';
    if (message.includes('[build.apk]')) return 'build.apk';
    if (message.includes('[build.windows]')) return 'build.windows';
    if (message.includes('[build.linux]')) return 'build.linux';
    if (message.includes('[build.ios]')) return 'build.ios';
    if (message.includes('[build.macos]')) return 'build.macos';
  }
  return null;
}

// Get latest workflow run status
async function getWorkflowStatus() {
  try {
    const response = await axios.get(WORKFLOW_URL, { headers });
    const latestRun = response.data.workflow_runs[0];
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
async function waitForWorkflowCompletion() {
  const maxAttempts = 60; // Wait up to 30 minutes (60 * 30s)
  let attempts = 0;

  while (attempts < maxAttempts) {
    const workflow = await getWorkflowStatus();
    if (!workflow) {
      console.error('Failed to fetch workflow status.');
      return false;
    }

    if (workflow.status === 'completed') {
      if (workflow.conclusion === 'success') {
        console.log('Workflow completed successfully.');
        return true;
      } else {
        console.log(`Workflow failed with conclusion: ${workflow.conclusion}`);
        return false;
      }
    }

    console.log('Workflow still running, waiting 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    attempts++;
  }

  console.error('Workflow did not complete in time.');
  return false;
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
  const commits = await getExternalRepoCommits();
  const buildType = getBuildType(commits);

  if (!buildType) {
    console.log('No matching build commit found.');
    return;
  }

  console.log(`Detected ${buildType} commit.`);

  // Wait for dart.yml workflow to complete
  const workflowSuccess = await waitForWorkflowCompletion();
  if (!workflowSuccess) {
    console.error('Workflow did not succeed, skipping release.');
    return;
  }

  // Trigger download and release
  triggerDownloadAndRelease(buildType);
}

main();
