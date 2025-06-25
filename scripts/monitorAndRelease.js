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
const JOBS_URL = (runId) => `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/actions/runs/${runId}/jobs`;

// Headers for GitHub API
const headers = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
};

// File to store the last processed commit SHA
const LAST_PROCESSED_FILE = 'last_processed_commit.txt';

// Map build tags to job names (adjusted for underscores based on dart.yml)
const BUILD_TAG_TO_JOB = {
  'build.all': ['build_android', 'build_windows', 'build_macos', 'build_linux', 'build_ios'],
  'build.apk': ['build_android'], // Assuming Android builds APKs
  'build.windows': ['build_windows'],
  'build.macos': ['build_macos'],
  'build.linux': ['build_linux'],
  'build.ios': ['build_ios']
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

// Get workflow run details for a specific commit SHA
async function getWorkflowRunForCommit(sha) {
  try {
    const response = await axios.get(`${WORKFLOW_URL}?head_sha=${sha}`, { headers });
    const runs = response.data.workflow_runs;
    if (runs.length === 0) {
      console.log(`No workflow runs found for commit ${sha}`);
      return null;
    }
    return runs[0]; // Latest run for this commit
  } catch (error) {
    console.error('Error fetching workflow run:', error.message);
    return null;
  }
}

// Get job statuses for a workflow run
async function getJobStatuses(runId) {
  try {
    const response = await axios.get(JOBS_URL(runId), { headers });
    return response.data.jobs;
  } catch (error) {
    console.error('Error fetching job statuses:', error.message);
    return [];
  }
}

// Check if required jobs succeeded
async function checkJobSuccess(sha, buildType) {
  const run = await getWorkflowRunForCommit(sha);
  if (!run || run.status !== 'completed') {
    console.log(`Workflow for commit ${sha} is not completed.`);
    return false;
  }

  const jobs = await getJobStatuses(run.id);
  const requiredJobs = BUILD_TAG_TO_JOB[buildType] || [];
  const successfulJobs = jobs.filter(job => job.conclusion === 'success' && requiredJobs.includes(job.name.toLowerCase()));

  if (requiredJobs.length === 0) {
    console.log(`No specific jobs defined for ${buildType}, checking overall success.`);
    return run.conclusion === 'success';
  }

  const allRequiredSucceeded = requiredJobs.every(job => successfulJobs.some(j => j.name.toLowerCase() === job));
  console.log(`Required jobs for ${buildType}: ${requiredJobs.join(', ')}`);
  console.log(`Successful jobs: ${successfulJobs.map(j => j.name).join(', ')}`);
  return allRequiredSucceeded;
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

  // Check job success for this build type
  const jobSuccess = await checkJobSuccess(sha, buildType);
  if (!jobSuccess) {
    console.error(`Required jobs for commit ${sha} did not succeed, skipping release.`);
    return;
  }

  // Trigger download and release
  triggerDownloadAndRelease(buildType);

  // Update last processed commit
  await writeLastProcessedCommit(sha);
}

main();
