# [Dartotsu](https://github.com/aayush2622/Dartotsu) Build Monitor and Release Automation
This repository automates the process of monitoring the `aayush2622/Dartotsu` repository for build-related commits, downloading build artifacts from Google Drive folders, and creating or updating releases in the `itsmechinmoy/dartotsu-updater` GitHub repository. The workflow checks for commits with specific build tags (e.g., `[build.all]`, `[build.apk]`, `[build.windows]`), verifies successful workflow runs, and releases the downloaded files as GitHub release assets.

## Features
- Monitors `aayush2622/Dartotsu` for commits containing build tags like `[build.all]`, `[build.apk]`, `[build.windows]`, `[build.linux]`, `[build.ios]`, or `[build.macos]`.
- Verifies successful completion of the `dart.yml` workflow in `aayush2622/Dartotsu` for the detected commit.
- Downloads build artifacts from specified Google Drive folders:
  - APKs: `1S4QzdKz7ZofhiF5GAvjMdBvYK7YhndKM`
  - Other builds (DMG, EXE, etc.): `1nWYex54zd58SVitJUCva91_4k1PPTdP3`
- Creates a new GitHub release for `[build.all]` commits using the commit SHA as the tag (e.g., `abc1234`).
- Updates the latest release for specific build tags (e.g., `[build.apk]`) by replacing existing assets with matching names.
- Tracks processed commits to avoid duplicate releases using `last_processed_commit.txt`.
- Commits downloaded files to the `downloads` directory in the repository.

## Prerequisites
1. **Google Drive API Credentials**:
   - A service account JSON key with `Viewer` access to the Google Drive folders.
2. **GitHub Personal Access Token (PAT)**:
   - A PAT with `repo` scope to access `aayush2622/Dartotsu` and manage releases in `itsmechinmoy/dartotsu-updater`.
3. **Node.js and Python 3.x**:
   - Node.js for running the monitoring script (`monitorAndRelease.js`).
   - Python for downloading and releasing files (`download_and_release.py`).

### Required Node.js Dependencies
- `axios`

### Required Python Libraries
- `google-api-python-client`
- `google-auth`
- `google-auth-oauthlib`
- `google-auth-httplib2`
- `requests`

Install the Python libraries using `pip`:
```bash
pip install google-api-python-client google-auth google-auth-oauthlib google-auth-httplib2 requests
```

Install the Node.js dependency:
```bash
npm install axios
```

## Setup
1. **Clone this repository**:
   ```bash
   git clone https://github.com/itsmechinmoy/dartotsu-updater.git
   cd dartotsu-updater
   ```

2. **Configure Google Drive Credentials**:
   - Create a service account in the [Google Cloud Console](https://console.cloud.google.com/).
   - Enable the Google Drive API for your project.
   - Generate a JSON key for the service account (e.g., `dartotsu-updater@dartotsu-updater.iam.gserviceaccount.com`).
   - Share the Google Drive folders with the service account email as a `Viewer`:
     - APKs: `1S4QzdKz7ZofhiF5GAvjMdBvYK7YhndKM`
     - Others: `1nWYex54zd58SVitJUCva91_4k1PPTdP3`
   - Add the JSON key as a GitHub secret named `SERVICE_ACCOUNT_JSON` (see below).

3. **Set up GitHub Token**:
   - Generate a Personal Access Token (PAT) in GitHub with `repo` scope.
   - Add the PAT as a GitHub secret named `GITHUB_TOKEN` in `itsmechinmoy/dartotsu-updater`.

4. **Add GitHub Secrets**:
   - Go to **Settings** > **Secrets and variables** > **Actions** in `itsmechinmoy/dartotsu-updater`.
   - Add the following secrets:
     - `GITHUB_TOKEN`: Your PAT with `repo` scope.
     - `SERVICE_ACCOUNT_JSON`: The raw JSON content of the service account key (not base64-encoded).

5. **Repository Structure**:
   - Ensure the following files are in the repository:
     - `.github/workflows/build_and_release.yml`: The GitHub Actions workflow.
     - `scripts/monitorAndRelease.js`: The Node.js script for monitoring commits.
     - `download_and_release.py`: The Python script for downloading and releasing builds.
     - `last_processed_commit.txt`: A file to track the last processed commit SHA (created automatically if not present).

6. **Run the Workflow**:
   - The workflow runs automatically every 30 minutes or can be triggered manually via `workflow_dispatch`.
   - To test locally (not recommended due to secret dependencies), set environment variables for `GITHUB_TOKEN` and `SERVICE_ACCOUNT_JSON` and run:
     ```bash
     node scripts/monitorAndRelease.js
     ```

## How It Works
1. **Monitor `aayush2622/Dartotsu`**:
   - The `monitorAndRelease.js` script checks for new commits in `aayush2622/Dartotsu` with build tags (e.g., `[build.all]`, `[build.apk]`).
   - It verifies that the `dart.yml` workflow for the commit completed successfully.

2. **Download Builds from Google Drive**:
   - The `download_and_release.py` script fetches files from both Google Drive folders (APKs and others).
   - It uses file hashes (MD5) to skip unchanged files.
   - Downloaded files are saved in the `downloads` directory.

3. **Create or Update GitHub Release**:
   - For `[build.all]` commits, a new release is created with a tag based on the commit SHA (e.g., `abc1234`).
   - For specific build tags (e.g., `[build.apk]`), the latest release is updated by replacing assets with matching names.
   - Files are uploaded as release assets via the GitHub API.

4. **Track Processed Commits**:
   - The commit SHA is saved in `last_processed_commit.txt` to prevent re-processing.
   - Commits are attributed to `itsmechinmoy` with the email `167056923+itsmechinmoy@users.noreply.github.com`.

## GitHub Action Workflow
The workflow is defined in `.github/workflows/build_and_release.yml`:

```yaml
name: Monitor and Release Builds

on:
  schedule:
    - cron: '*/30 * * * *' # Runs every 30 minutes
  workflow_dispatch:

jobs:
  monitor-and-release:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install Node dependencies
        run: npm install axios

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.9'

      - name: Install Python dependencies
        run: |
          python -m pip install --upgrade pip
          pip install google-api-python-client google-auth google-auth-oauthlib google-auth-httplib2 requests

      - name: Monitor External Repo and Process Builds
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SERVICE_ACCOUNT_JSON: ${{ secrets.SERVICE_ACCOUNT_JSON }}
        run: node scripts/monitorAndRelease.js

      - name: Commit last processed commit SHA
        run: |
          git config --global user.name 'itsmechinmoy'
          git config --global user.email '167056923+itsmechinmoy@users.noreply.github.com'
          git add last_processed_commit.txt
          if ! git diff --cached --quiet; then
            git commit -m "Update last processed commit SHA"
            git push origin main
          else
            echo "No changes to commit for last_processed_commit.txt"
          fi
        if: always()
```

## Troubleshooting
- **No Builds Downloaded**:
  - Verify the service account has `Viewer` access to both Google Drive folders.
  - Check that files exist in the folders.
- **Workflow Skips Commits**:
  - Ensure `last_processed_commit.txt` contains the correct SHA.
  - Confirm new commits with build tags exist in `aayush2622/Dartotsu`.
- **Authentication Errors**:
  - Check that `GITHUB_TOKEN` has `repo` scope and access to `aayush2622/Dartotsu`.
  - Ensure `SERVICE_ACCOUNT_JSON` is valid and not corrupted.
- **Large File Warnings**:
  - Files like `Dartotsu.apk` (>50 MB) may trigger GitHub warnings. Consider using Git LFS:
    ```bash
    git lfs install
    git lfs track "*.apk" "*.dmg" "*.exe"
    git add .gitattributes
    git commit -m "Track large files with LFS"
    git push origin main
    ```

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
