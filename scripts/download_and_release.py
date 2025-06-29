import os
import io
import hashlib
import requests
import json
import sys
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google.oauth2 import service_account
from googleapiclient.errors import HttpError
import subprocess

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
GITHUB_DOWNLOADS_PATH = os.path.join(os.getcwd(), "downloads")
FOLDER_IDS = {
    'apks': '1S4QzdKz7ZofhiF5GAvjMdBvYK7YhndKM',
    'others': '1nWYex54zd58SVitJUCva91_4k1PPTdP3'
}

DESIRED_ORDER = [
    'Dartotsu.apk',
    'Dartotsu_Android_arm64-v8a_main.apk',
    'Dartotsu_Android_armeabi-v7a_main.apk',
    'Dartotsu_Android_x86_64_main.apk',
    'Dartotsu-iOS-main.ipa',
    'Dartotsu_windows.exe',
    'Dartotsu_linux.zip',
    'Dartotsu_Linux.AppImage',
    'Dartotsu-macos-main.dmg'
]

if len(sys.argv) < 3:
    print("Usage: python download_and_release.py '<SERVICE_ACCOUNT_JSON>' <build_type> [<commit_logs>]")
    sys.exit(1)

service_account_info = json.loads(sys.argv[1]) if sys.argv[1] else None
if not service_account_info:
    print("Error: SERVICE_ACCOUNT_JSON is not provided or invalid, file operations will fail.")
    sys.exit(1)

try:
    credentials = service_account.Credentials.from_service_account_info(service_account_info, scopes=SCOPES)
    drive_service = build('drive', 'v3', credentials=credentials)
except json.JSONDecodeError as e:
    print(f"Invalid service account JSON: {str(e)}")
    sys.exit(1)
except Exception as e:
    print(f"Error setting up Google Drive service: {str(e)}")
    sys.exit(1)

build_type = sys.argv[2]
commit_logs = sys.argv[3].replace('%0A', '\n').replace('%0D', '\r').replace('%25', '%') if len(sys.argv) > 3 else ''
GITHUB_REPO = os.getenv("GITHUB_REPOSITORY", "itsmechinmoy/dartotsu-updater")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

def fetch_files(folder_id):
    try:
        results = drive_service.files().list(
            q=f"'{folder_id}' in parents",
            fields="files(id, name)"
        ).execute()
        return results.get('files', [])
    except HttpError as e:
        print(f"Error fetching files from folder ID {folder_id}: {str(e)}")
        return []

def calculate_file_hash(file_path):
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()

def download_file(file_id, file_name):
    try:
        request = drive_service.files().get_media(fileId=file_id)
        file_path = os.path.join(GITHUB_DOWNLOADS_PATH, file_name)
        os.makedirs(GITHUB_DOWNLOADS_PATH, exist_ok=True)

        with io.FileIO(file_path, "wb") as fh:
            downloader = MediaIoBaseDownload(fh, request)
            done = False
            while not done:
                status, done = downloader.next_chunk()
                print(f"Downloading {file_name}... {int(status.progress() * 100)}%")
        return file_path
    except HttpError as e:
        if "fileNotDownloadable" in str(e):
            print(f"Skipping non-downloadable file: {file_name}")
            return None
        else:
            raise

def get_external_commit_hash(repo):
    url = f"https://api.github.com/repos/{repo}/commits"
    headers = {"Authorization": f"token {GITHUB_TOKEN}"}
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        commit_sha = response.json()[0].get('sha')
        return commit_sha[:7] if commit_sha else "0000000"
    else:
        print(f"Failed to fetch commits from {repo}: {response.text}")
        return "0000000"

def get_release_assets(repo, token, tag):
    assets_url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
    response = requests.get(assets_url, headers=headers)
    if response.status_code != 200:
        print(f"Release {tag} not found, proceeding with new release.")
        return {}
    
    release = response.json()
    assets = release.get('assets', [])
    asset_checksums = {}
    for asset in assets:
        local_path = os.path.join(GITHUB_DOWNLOADS_PATH, asset['name'])
        if os.path.exists(local_path):
            local_checksum = calculate_file_hash(local_path)
            asset_checksums[asset['name']] = local_checksum
            print(f"Release checksum for {asset['name']} (from local): {local_checksum}")
        else:
            asset_response = requests.get(asset['url'], headers=headers, allow_redirects=True)
            if asset_response.status_code == 200:
                checksum = hashlib.sha256(asset_response.content).hexdigest()
                asset_checksums[asset['name']] = checksum
                print(f"Release checksum for {asset['name']} (from API): {checksum}")
    return dict(sorted(asset_checksums.items(), key=lambda x: DESIRED_ORDER.index(x[0]) if x[0] in DESIRED_ORDER else len(DESIRED_ORDER)))

def create_github_release(repo, token, tag, files_dict, commit_logs, checksum_table):
    release_url = f"https://api.github.com/repos/{repo}/releases"
    headers = {"Authorization": f"token {token}"}

    release_check_url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    check_response = requests.get(release_check_url, headers=headers)
    existing_checksums = get_release_assets(repo, token, tag) if check_response.status_code == 200 else {}

    body = "## Commit Logs\n" + commit_logs + "\n\n" if commit_logs and commit_logs.strip() not in ['● No new commits', '● No workflow run data available', '● No sendMessage job found', '● Error fetching commit logs'] else ""
    if checksum_table:
        body += "## Checksum Table\n" + checksum_table

    local_checksums = {name: calculate_file_hash(path) for name, path in files_dict.items()}

    should_create_or_update = True
    updated_assets = {}
    if existing_checksums:
        all_match = True
        print("Comparing checksums:")
        for name in DESIRED_ORDER:
            if name in local_checksums and name in existing_checksums:
                print(f"{name}: Local={local_checksums[name]}, Release={existing_checksums[name]}")
                if local_checksums[name] != existing_checksums[name]:
                    print(f"Changes detected for {name}, updating asset.")
                    all_match = False
                    updated_assets[name] = files_dict[name]
            elif name in local_checksums and name not in existing_checksums:
                print(f"New file detected: {name}, adding asset.")
                all_match = False
                updated_assets[name] = files_dict[name]
            elif name not in local_checksums and name in existing_checksums:
                print(f"Missing file detected: {name}, skipping.")
        if all_match:
            print("All files match existing release, release not created or updated.")
            should_create_or_update = False
    else:
        updated_assets = files_dict  # All files are new if no release exists

    if should_create_or_update:
        if check_response.status_code == 200:
            print(f"Updating existing release with tag '{tag}'.")
            release_id = check_response.json()['id']
            release_data = {"tag_name": tag, "name": tag, "body": body}
            release_response = requests.patch(f"{release_url}/{release_id}", json=release_data, headers=headers)
            if release_response.status_code != 200:
                raise Exception(f"Failed to update release: {release_response.content}")
        else:
            print(f"Creating new release with tag '{tag}'.")
            release_data = {"tag_name": tag, "name": tag, "body": body}
            release_response = requests.post(release_url, json=release_data, headers=headers)
            if release_response.status_code != 201:
                raise Exception(f"Failed to create release: {release_response.content}")

        release = release_response.json()
        upload_url = release["upload_url"].split("{")[0]
        upload_files_ordered(upload_url, headers, updated_assets)
        print(f"Release {tag} {'updated' if check_response.status_code == 200 else 'created'} successfully.")

def upload_files_ordered(upload_url, headers, files_dict):
    for file_name in DESIRED_ORDER:
        if file_name in files_dict:
            file_path = files_dict[file_name]
            with open(file_path, "rb") as f:
                headers.update({"Content-Type": "application/octet-stream"})
                response = requests.post(
                    f"{upload_url}?name={file_name}", headers=headers, data=f
                )
                if response.status_code not in (200, 201):
                    raise Exception(f"Failed to upload file {file_name}: {response.content}")
            print(f"Uploaded {file_name} to GitHub release.")

def configure_git_identity():
    subprocess.run(['git', 'config', '--global', 'user.name', 'itsmechinmoy'], check=True)
    subprocess.run(['git', 'config', '--global', 'user.email', '167056923+itsmechinmoy@users.noreply.github.com'], check=True)
    print("Configured Git identity.")

def commit_and_push():
    try:
        subprocess.run(['git', 'add', '.'], check=True)
        result = subprocess.run(['git', 'diff', '--cached', '--quiet'])
        if result.returncode == 0:
            print("No changes to commit.")
            return
        subprocess.run(['git', 'commit', '-m', f'Add build files'], check=True)
        subprocess.run(['git', 'push', 'origin', 'main'], check=True)
        print("Committed and pushed files to GitHub.")
    except subprocess.CalledProcessError as e:
        print(f"Error during git operations: {e}")

def main():
    downloaded_files = {}
    existing_files_hashes = {}

    folders_to_check = [FOLDER_IDS['apks'], FOLDER_IDS['others']]
    for folder_id in folders_to_check:
        print(f"Fetching files from folder ID: {folder_id}")
        files = fetch_files(folder_id)
        if not files:
            print(f"No files found in folder ID: {folder_id}")
            continue
        
        for file in files:
            file_id = file['id']
            file_name = file['name']
            print(f"Found file: {file_name}")
            file_path = download_file(file_id, file_name)
            if file_path:
                file_hash = calculate_file_hash(file_path)
                print(f"Local checksum for {file_name}: {file_hash}")
                if file_name not in existing_files_hashes or existing_files_hashes[file_name] != file_hash:
                    downloaded_files[file_name] = file_path
                    existing_files_hashes[file_name] = file_hash
                else:
                    print(f"File {file_name} is unchanged. Skipping.")

    checksum_table = "| File Name | SHA-256 Checksum |\n|-----------|-----------------|\n"
    for file_name in DESIRED_ORDER:
        if file_name in downloaded_files:
            checksum = calculate_file_hash(downloaded_files[file_name])
            checksum_table += f"| {file_name} | sha256:{checksum} |\n"

    if downloaded_files:
        configure_git_identity()
        commit_and_push()

        EXTERNAL_REPO = "aayush2622/Dartotsu"
        tag_name = get_external_commit_hash(EXTERNAL_REPO)
        print(f"Using tag based on external commit hash: {tag_name}")

        if build_type != 'update_note':
            create_github_release(GITHUB_REPO, GITHUB_TOKEN, tag_name, downloaded_files, commit_logs, checksum_table)
    else:
        print("No new or changed files to process.")

if __name__ == "__main__":
    main()
