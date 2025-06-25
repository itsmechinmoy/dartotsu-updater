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

# Constants
SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
GITHUB_DOWNLOADS_PATH = os.path.join(os.getcwd(), "downloads")
FOLDER_IDS = {
    'apks': '1S4QzdKz7ZofhiF5GAvjMdBvYK7YhndKM',
    'others': '1nWYex54zd58SVitJUCva91_4k1PPTdP3'
}

# Get service account JSON and build type from command-line arguments
if len(sys.argv) < 3:
    print("Usage: python download_and_release.py '<SERVICE_ACCOUNT_JSON>' <build_type>")
    sys.exit(1)

try:
    service_account_info = json.loads(sys.argv[1])
    credentials = service_account.Credentials.from_service_account_info(service_account_info, scopes=SCOPES)
    drive_service = build('drive', 'v3', credentials=credentials)
except Exception as e:
    print("Invalid service account JSON:", str(e))
    sys.exit(1)

build_type = sys.argv[2]
GITHUB_REPO = os.getenv("GITHUB_REPOSITORY", "itsmechinmoy/dartotsu-updater")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

# Function to fetch files in a folder
def fetch_files(folder_id):
    results = drive_service.files().list(
        q=f"'{folder_id}' in parents",
        fields="files(id, name)"
    ).execute()
    return results.get('files', [])

# Function to calculate file hash (MD5)
def calculate_file_hash(file_path):
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

# Function to download a file from Google Drive
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

# Function to get latest release
def get_latest_release(repo, token):
    release_url = f"https://api.github.com/repos/{repo}/releases/latest"
    headers = {"Authorization": f"token {token}"}
    response = requests.get(release_url, headers=headers)
    if response.status_code == 200:
        return response.json()
    return None

# Function to create a new GitHub release
def create_github_release(repo, token, tag, files):
    release_url = f"https://api.github.com/repos/{repo}/releases"
    headers = {"Authorization": f"token {token}"}
    release_data = {"tag_name": tag, "name": tag, "body": f"Automated release for {build_type}"}
    response = requests.post(release_url, json=release_data, headers=headers)
    if response.status_code != 201:
        raise Exception(f"Failed to create release: {response.content}")

    release = response.json()
    upload_url = release["upload_url"].split("{")[0]
    upload_files(upload_url, headers, files)
    print(f"Release {tag} created successfully.")

# Function to update existing release
def update_github_release(repo, token, release_id, files):
    headers = {"Authorization": f"token {token}"}
    release_url = f"https://api.github.com/repos/{repo}/releases/{release_id}"
    release = requests.get(release_url, headers=headers).json()
    upload_url = release["upload_url"].split("{")[0]

    # Delete existing assets with matching names
    for file_path in files:
        file_name = os.path.basename(file_path)
        for asset in release["assets"]:
            if asset["name"] == file_name:
                requests.delete(f"https://api.github.com/repos/{repo}/releases/assets/{asset['id']}", headers=headers)
                print(f"Deleted old asset: {file_name}")

    # Upload new files
    upload_files(upload_url, headers, files)
    print(f"Updated release {release['tag_name']} with new files.")

# Function to upload files to a release
def upload_files(upload_url, headers, files):
    for file_path in files:
        if file_path:
            file_name = os.path.basename(file_path)
            with open(file_path, "rb") as f:
                headers.update({"Content-Type": "application/octet-stream"})
                response = requests.post(
                    f"{upload_url}?name={file_name}", headers=headers, data=f
                )
                if response.status_code not in (200, 201):
                    raise Exception(f"Failed to upload file {file_name}: {response.content}")
            print(f"Uploaded {file_name} to GitHub release.")

# Function to get external commit hash
def get_external_commit_hash(repo):
    url = f"https://api.github.com/repos/{repo}/commits"
    response = requests.get(url)
    if response.status_code == 200:
        commit_sha = response.json()[0].get('sha')
        return commit_sha[:7] if commit_sha else "0000000"
    else:
        print(f"Failed to fetch commits from {repo}: {response.text}")
        return "00000"

# Function to configure git user identity
def configure_git_identity():
    subprocess.run(['git', 'config', '--global', 'user.name', 'Sheby'], check=True)
    subprocess.run(['git', 'config', '--global', 'user.email', 'sheby@gmail.com'], check=True)
    print("Configured Git identity.")

# Function to commit and push changes
def commit_and_push():
    try:
        subprocess.run(['git', 'add', '.'], check=True)
        result = subprocess.run(['git', 'diff', '--cached', '--quiet'])
        if result.returncode == 0:
            print("No changes to commit.")
            return
        subprocess.run(['git', 'commit', '-m', f'Add {build_type} files'], check=True)
        subprocess.run(['git', 'push', 'origin', 'main'], check=True)
        print("Committed and pushed files to GitHub.")
    except subprocess.CalledProcessError as e:
        print(f"Error during git operations: {e}")

# Main logic
def main():
    downloaded_files = []
    existing_files_hashes = {}

    # Determine which folders to check based on build type
    folders_to_check = []
    if build_type == 'build.all':
        folders_to_check = [FOLDER_IDS['apks'], FOLDER_IDS['others']]
    elif build_type == 'build.apk':
        folders_to_check = [FOLDER_IDS['apks']]
    else:
        folders_to_check = [FOLDER_IDS['others']]

    # Download files
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
                if file_name not in existing_files_hashes or existing_files_hashes[file_name] != file_hash:
                    downloaded_files.append(file_path)
                    existing_files_hashes[file_name] = file_hash
                else:
                    print(f"File {file_name} is unchanged. Skipping.")

    # Process downloaded files
    if downloaded_files:
        configure_git_identity()
        commit_and_push()

        EXTERNAL_REPO = "aayush2622/Dartotsu"
        tag_name = get_external_commit_hash(EXTERNAL_REPO)
        print(f"Using tag: {tag_name}")

        if build_type == 'build.all':
            # Check if release exists
            release_check_url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag_name}"
            headers = {"Authorization": f"token {GITHUB_TOKEN}"}
            check_response = requests.get(release_check_url, headers=headers)

            if check_response.status_code == 200:
                print(f"Release with tag '{tag_name}' already exists. Skipping.")
            else:
                create_github_release(GITHUB_REPO, GITHUB_TOKEN, tag_name, downloaded_files)
        else:
            # Update latest release for specific builds
            latest_release = get_latest_release(GITHUB_REPO, GITHUB_TOKEN)
            if latest_release:
                update_github_release(GITHUB_REPO, GITHUB_TOKEN, latest_release['id'], downloaded_files)
            else:
                print("No existing release found. Creating new release.")
                create_github_release(GITHUB_REPO, GITHUB_TOKEN, tag_name, downloaded_files)
    else:
        print("No new or changed files to process.")

if __name__ == "__main__":
    main()
