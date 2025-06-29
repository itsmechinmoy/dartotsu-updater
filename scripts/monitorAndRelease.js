const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs').promises;

const EXTERNAL_REPO_OWNER = 'aayush2622';
const EXTERNAL_REPO = 'Dartotsu';
const YOUR_REPO = 'itsmechinmoy/dartotsu-updater';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const COMMITS_URL = `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commits`;
const WORKFLOW_URL = `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/actions/workflows/dart.yml/runs`;
const JOBS_URL = (runId) => `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/actions/runs/${runId}/jobs`;
const LOGS_URL = (jobId) => `https://api.github.com/repos/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/actions/jobs/${jobId}/logs`;

const headers = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
};

const LAST_PROCESSED_FILE = 'last_processed_commit.txt';

const BUILD_TAG_TO_JOB = {
  'build.all': ['build_android', 'build_windows', 'build_macos', 'build_linux', 'build_ios'],
  'build.apk': ['build_android'],
  'build.windows': ['build_windows'],
  'build.macos': ['build_macos'],
  'build.linux': ['build_linux'],
  'build.ios': ['build_ios']
};

async function getExternalRepoCommits() {
  try {
    const response = await axios.get(COMMITS_URL, { headers });
    return response.data;
  } catch (error) {
    console.error('Error fetching commits:', error.message);
    return [];
  }
}

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

async function getLatestWorkflowRun(sha) {
  try {
    const response = await axios.get(WORKFLOW_URL, { headers, params: { per_page: 30, status: 'completed' } });
    const runs = response.data.workflow_runs;
    const matchingRun = runs.find(run => run.head_sha === sha);
    if (!matchingRun) {
      console.log(`No exact match for commit ${sha}. Checking recent runs...`);
      const recentRun = runs.find(run => run.conclusion === 'success');
      if (recentRun) {
        console.log(`Using recent successful run with SHA: ${recentRun.head_sha}`);
        return recentRun;
      }
    }
    return matchingRun || null;
  } catch (error) {
    console.error('Error fetching latest workflow run:', error.message);
    return null;
  }
}

async function getJobStatuses(runId) {
  try {
    const response = await axios.get(JOBS_URL(runId), { headers });
    return response.data.jobs;
  } catch (error) {
    console.error('Error fetching job statuses:', error.message);
    return [];
  }
}

async function checkJobSuccess(sha, buildType) {
  const run = await getLatestWorkflowRun(sha);
  if (!run || run.status !== 'completed') {
    console.log(`Workflow for commit ${sha} is not completed or not found.`);
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

  if (buildType === 'build.all') {
    if (allRequiredSucceeded) {
      console.log(`All jobs succeeded for ${buildType}.`);
      return true;
    } else if (successfulJobs.length > 0) {
      console.log(`Partial success detected for ${buildType}, proceeding with available builds.`);
      return true;
    }
    console.log(`No jobs succeeded for ${buildType}, skipping release.`);
    return false;
  }

  return allRequiredSucceeded;
}

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

async function writeLastProcessedCommit(sha) {
  try {
    await fs.writeFile(LAST_PROCESSED_FILE, sha);
    console.log(`Updated last processed commit to ${sha}`);
  } catch (error) {
    console.error('Error writing last processed commit:', error.message);
  }
}

async function getCommitLogsFromSendMessage(lastSha, currentSha) {
  if (!currentSha) {
    const commits = await getExternalRepoCommits();
    currentSha = commits.length > 0 ? commits[0].sha : null;
    if (!currentSha) {
      console.log('No current SHA available from commits API.');
      return '● No workflow run data available';
    }
  }

  try {
    const run = await getLatestWorkflowRun(currentSha);
    if (!run) {
      console.log(`No matching workflow run found for commit ${currentSha}`);
      return '● No workflow run data available';
    }

    const jobs = await getJobStatuses(run.id);
    const sendMessageJob = jobs.find(job => job.name.toLowerCase().includes('sendmessage') || job.name.toLowerCase().includes('send_message'));
    
    if (!sendMessageJob) {
      console.log('Available jobs:', jobs.map(j => j.name).join(', '));
      console.error('No sendMessage job found in workflow run');
      return '● No sendMessage job found';
    }

    console.log(`Found sendMessage job: ${sendMessageJob.name}`);
    
    try {
      const logsResponse = await axios.get(LOGS_URL(sendMessageJob.id), { 
        headers,
        responseType: 'text'
      });
      
      if (logsResponse.status !== 200) {
        console.error(`Failed to fetch logs for job ${sendMessageJob.id}: ${logsResponse.statusText}`);
        return '● Error fetching sendMessage logs';
      }

      const logs = logsResponse.data;
      console.log('Logs fetched successfully, processing...');
      
      const commitLines = logs.split('\n')
        .filter(line => {
          return (line.includes('●') || line.includes('•') || line.includes('-')) &&
                 (line.includes('[') && line.includes(']') && line.includes('~') ||
                  line.includes('chore:') || line.includes('fix:') || line.includes('added') || line.includes('upgraded')) &&
                 !line.includes('runner') &&
                 !line.includes('image') &&
                 !line.includes('ubuntu') &&
                 !line.includes('version') &&
                 !line.includes('[command]') &&
                 !line.includes('#') &&
                 !line.includes('sed') &&
                 !line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/);
        })
        .map(line => {
          let cleanLine = line.trim();
          const shaMatch = cleanLine.match(/([a-f0-9]{40})/i);
          const sha = shaMatch ? shaMatch[0] : currentSha;
          
          if (cleanLine.includes('~')) {
            const parts = cleanLine.split('~');
            const message = parts[0].replace(/^[●•\-\s]+/, '').trim().split(/ \[|\<a/)[0];
            const author = parts[1] ? parts[1].split(/ \[|\<a/)[0].trim() : 'Unknown';
            return `● ${message} ~${author} [֍](https://github.com/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commit/${sha})`;
          } else {
            const message = cleanLine.replace(/^[●•\-\s]+/, '').trim().split(/ \[|\<a/)[0];
            return `● ${message} [֍](https://github.com/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commit/${sha})`;
          }
        })
        .filter(line => line.length > 10 && !line.includes('%') && !line.includes('(.)'));

      if (commitLines.length === 0 && lastSha !== currentSha) {
        console.log('No commit logs found in sendMessage, fetching from commits API since last processed SHA...');
        const commits = await getExternalRepoCommits();
        const startIndex = commits.findIndex(commit => commit.sha === lastSha) + 1;
        const newCommits = commits.slice(startIndex > 0 ? startIndex : 0).map(commit => {
          const message = commit.commit.message.split('\n')[0];
          const author = commit.commit.author.name;
          const sha = commit.sha;
          return `● ${message} ~${author} [֍](https://github.com/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commit/${sha})`;
        });
        
        const commitLog = newCommits.length > 0 ? newCommits.join('\n') : '● No new commits';
        console.log('Commit Logs from API:\n' + commitLog);
        return commitLog.replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D');
      }

      const commitLog = commitLines.join('\n');
      console.log('Commit Logs:\n' + commitLog);
      return commitLog.replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D');
      
    } catch (logError) {
      console.error('Error fetching job logs:', logError.message);
      console.log('Falling back to commits API...');
      const commits = await getExternalRepoCommits();
      const startIndex = commits.findIndex(commit => commit.sha === lastSha) + 1;
      const newCommits = commits.slice(startIndex > 0 ? startIndex : 0).map(commit => {
        const message = commit.commit.message.split('\n')[0];
        const author = commit.commit.author.name;
        return `● ${message} ~${author} [֍](https://github.com/${EXTERNAL_REPO_OWNER}/${EXTERNAL_REPO}/commit/${commit.sha})`;
      });
      
      const commitLog = newCommits.length > 0 ? newCommits.join('\n') : '● No new commits';
      return commitLog.replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D');
    }
    
  } catch (error) {
    console.error('Error fetching commit logs from sendMessage:', error.message);
    return '● Error fetching commit logs';
  }
}

function triggerDownloadAndRelease(buildType, commitLogs) {
  try {
    const serviceAccountJson = process.env.SERVICE_ACCOUNT_JSON || '';
    if (!serviceAccountJson) {
      console.error('Error: SERVICE_ACCOUNT_JSON is not set, file operations will fail.');
      return;
    }
    const escapedLogs = commitLogs.replace(/"/g, '\\"');
    execSync(`python scripts/download_and_release.py '${serviceAccountJson}' ${buildType} "${escapedLogs}"`, { stdio: 'inherit' });
    console.log('Download and release script executed successfully.');
  } catch (error) {
    console.error('Error executing download and release script:', error.message);
  }
}

async function main() {
  const lastProcessedSha = await readLastProcessedCommit();

  const commits = await getExternalRepoCommits();
  const buildInfo = getBuildTypeAndSha(commits);

  if (!buildInfo) {
    console.log('No matching build commit found.');
    return;
  }

  const { buildType, sha } = buildInfo;
  console.log(`Detected ${buildType} commit with SHA ${sha}.`);

  if (sha === lastProcessedSha) {
    console.log(`Commit ${sha} was already processed, checking for note update.`);
    const newCommitLogs = await getCommitLogsFromSendMessage(lastProcessedSha, sha);
    if (newCommitLogs && newCommitLogs !== '● No new commits' && newCommitLogs !== '● No workflow run data available' && newCommitLogs !== '● Error fetching commit logs') {
      console.log('New commits detected, updating release note.');
      triggerDownloadAndRelease('update_note', newCommitLogs);
    } else {
      console.log('No new commits to update release note.');
    }
    return;
  }

  const commitLogs = await getCommitLogsFromSendMessage(lastProcessedSha, sha);

  const jobSuccess = await checkJobSuccess(sha, buildType);
  if (!jobSuccess) {
    console.error(`Required jobs for commit ${sha} did not succeed, skipping release.`);
    return;
  }

  triggerDownloadAndRelease(buildType, commitLogs);

  await writeLastProcessedCommit(sha);
}

module.exports = { getCommitLogsFromSendMessage };

if (require.main === module) {
  main();
}
