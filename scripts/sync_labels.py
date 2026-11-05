"""Synchronize repository labels with the declarative config in .github/labels.yml.

Replaces the previously used third-party `EndBug/add-and-update-labels` action
(whose repository is no longer available) with a small, auditable first-party
script. Runs inside GitHub Actions and authenticates with the workflow's
``GITHUB_TOKEN``.

Behavior mirrors the old action's safe defaults:
    * Labels missing from the repository are created.
    * Labels whose color or description drifted from the config are updated.
    * Labels that exist in the repository but not in the config are left
      untouched unless ``PRUNE_LABELS=true`` is set (destructive opt-in).

Required environment:
    GITHUB_TOKEN       Token with ``issues: write`` permission.
    GITHUB_REPOSITORY  Target repository in ``owner/repo`` form.

Optional environment:
    LABELS_FILE        Path to the label config (default: .github/labels.yml).
    PRUNE_LABELS       "true" to delete labels absent from the config.
"""

from __future__ import annotations

import os
import sys

import requests
import yaml

API_ROOT = "https://api.github.com"
REQUEST_TIMEOUT_SECONDS = 30
COLOR_PATTERN_LENGTH = 6


class GitHubLabelsClient:
    """Thin REST client scoped to the /labels endpoint of one repository."""

    def __init__(self, token: str, repo_full_name: str) -> None:
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "label-sync-script",
            }
        )
        self._base_url = f"{API_ROOT}/repos/{repo_full_name}/labels"

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        response = self._session.request(
            method, url, timeout=REQUEST_TIMEOUT_SECONDS, **kwargs
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"{method} {url} failed with HTTP {response.status_code}: {response.text[:300]}"
            )
        return response

    def list_labels(self) -> dict:
        """Fetch all existing labels (paginated) keyed by name."""
        labels = {}
        url = f"{self._base_url}?per_page=100"
        while url:
            response = self._request("GET", url)
            for entry in response.json():
                labels[entry["name"]] = entry
            url = response.links.get("next", {}).get("url")
        return labels

    def _label_url(self, name: str) -> str:
        return f"{self._base_url}/{requests.utils.quote(name, safe='')}"

    def create_label(self, name: str, color: str, description: str) -> None:
        self._request(
            "POST",
            self._base_url,
            json={"name": name, "color": color, "description": description},
        )

    def update_label(self, name: str, color: str, description: str) -> None:
        self._request(
            "PATCH",
            self._label_url(name),
            json={"color": color, "description": description},
        )

    def delete_label(self, name: str) -> None:
        self._request("DELETE", self._label_url(name))


def load_label_config(path: str) -> list:
    """Parse and validate the declarative label config."""
    with open(path, encoding="utf-8") as handle:
        config = yaml.safe_load(handle)

    if not isinstance(config, list) or not config:
        raise SystemExit(f"{path} must contain a non-empty list of labels.")

    labels = []
    for entry in config:
        if not isinstance(entry, dict) or "name" not in entry:
            raise SystemExit(f"Invalid label entry in {path}: {entry!r}")
        name = str(entry["name"]).strip()
        color = str(entry.get("color", "ededed")).lstrip("#")
        if len(color) != COLOR_PATTERN_LENGTH:
            raise SystemExit(f"Label '{name}' has an invalid color '{color}' (expected 6 hex digits).")
        labels.append(
            {
                "name": name,
                "color": color,
                "description": str(entry.get("description", "")),
            }
        )
    return labels


def sync_labels(client: GitHubLabelsClient, desired: list, prune: bool) -> int:
    """Apply the desired label state; returns the number of changes made."""
    existing = client.list_labels()
    changes = 0

    for label in desired:
        current = existing.get(label["name"])
        if current is None:
            client.create_label(label["name"], label["color"], label["description"])
            print(f"created  '{label['name']}'")
            changes += 1
        elif (current.get("color") or "").lstrip("#").lower() != label["color"].lower() or (
            current.get("description") or ""
        ) != label["description"]:
            client.update_label(label["name"], label["color"], label["description"])
            print(f"updated  '{label['name']}'")
            changes += 1

    if prune:
        desired_names = {label["name"] for label in desired}
        for name in sorted(set(existing) - desired_names):
            client.delete_label(name)
            print(f"deleted  '{name}' (not present in config)")
            changes += 1

    return changes


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo_full_name = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token or not repo_full_name:
        print("GITHUB_TOKEN and GITHUB_REPOSITORY must be set.", file=sys.stderr)
        return 1

    labels_file = os.environ.get("LABELS_FILE", ".github/labels.yml")
    prune = os.environ.get("PRUNE_LABELS", "false").strip().lower() == "true"

    desired = load_label_config(labels_file)
    client = GitHubLabelsClient(token, repo_full_name)
    changes = sync_labels(client, desired, prune)

    print(f"Label sync finished for {repo_full_name}: {changes} change(s), {len(desired)} label(s) in config.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
