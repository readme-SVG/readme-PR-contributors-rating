"""Create GitHub issues and PR comments from AI-generated change analysis.

https://github.com/assembly-automation-hub/repo-governance

This script runs inside GitHub Actions and inspects either ``push`` or
``pull_request`` events. It collects the relevant diff, routes the change to a
role-specific review prompt (explicit labels win, otherwise the role is
auto-detected from file paths and diff content), sends the prompt to a hosted
model, and turns the structured JSON response into a GitHub issue plus an
optional pull request comment.

The workflow contract:
    * All inputs arrive through environment variables (see ``main``).
    * Expected, benign outcomes (unauthorized actor, empty diff, duplicate
      issue, model outage) exit with status ``0`` so the pipeline stays green.
    * Unexpected failures propagate and fail the step on purpose.

Attributes:
    MODEL_NAME (str): Model identifier used for every inference request.
    ENDPOINT (str): Azure inference API URL for chat completions.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import requests
from github import Auth, Github
from github.PullRequest import PullRequest
from github.Repository import Repository

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The inference backend is environment-configurable so a different model or
# gateway can be adopted without touching the code.
MODEL_NAME = os.environ.get("AI_MODEL", "Llama-3.3-70B-Instruct")
ENDPOINT = os.environ.get("AI_ENDPOINT", "https://models.inference.ai.azure.com/chat/completions")
MODEL_TIMEOUT_SECONDS = 60
MODEL_RETRIES = 3
MODEL_RETRY_DELAY_SECONDS = 5
MODEL_TEMPERATURE = 0.1

#: Hard caps (in characters) for the diff embedded into the model prompt.
PUSH_DIFF_CHAR_LIMIT = 10_000
PR_DIFF_CHAR_LIMIT = 80_000

#: Diffs smaller than this carry no analyzable content.
MIN_DIFF_CHARS = 50

#: Maximum number of issues scanned when looking for duplicates. The dedup
#: key is embedded in recent issue bodies, so a bounded scan is sufficient
#: and avoids O(all issues) API traffic on every run.
DEDUP_SCAN_ISSUE_LIMIT = 200

#: Maps model severities to the repository's ``severity: *`` labels.
SEVERITY_LABELS = {
    "critical": "severity: critical",
    "high": "severity: high",
    "elevated": "severity: elevated",
    "medium": "severity: medium",
    "moderate": "severity: moderate",
    "low": "severity: low",
    "informational": "severity: informational",
}
DEFAULT_SEVERITY = "medium"


@dataclass
class ChangeEvent:
    """Normalized view of the triggering push or pull request event."""

    dedup_key: str
    context: str
    diff_text: str
    changed_files: list = field(default_factory=list)
    trigger_labels: list = field(default_factory=list)
    pr_ref: Optional[PullRequest] = None


# ---------------------------------------------------------------------------
# Prompt assets
# ---------------------------------------------------------------------------

SEVERITY_GUIDE = """
Use the following severity scale. You have 7 levels — pick the one that best matches the ACTUAL impact:

CRITICAL — Production-breaking changes, security vulnerabilities (exposed secrets, SQL injection, XSS, CSRF, broken auth), data loss risks, or changes that could cause service outages.

HIGH — Significant logic changes affecting core functionality, new or modified API endpoints, permission and access control modifications, database schema changes, removal of important functionality, breaking changes to public interfaces.

ELEVATED — New substantial features or modules, large-scale refactors that change behavior across multiple files, integration with external services or APIs, changes to error handling or retry logic, modifications to data processing pipelines.

MEDIUM — New utility functions or helpers, workflow and CI/CD pipeline changes, configuration changes that affect runtime behavior, dependency version updates, adding new files with meaningful functionality, structural reorganization of existing code.

MODERATE — Minor feature additions, small behavioral changes, adding validation or input checks, improving logging or error messages, updating environment variables or build settings, adding new labels or issue templates.

LOW — Documentation updates (README, CONTRIBUTING, comments), cosmetic UI changes without behavior impact, code formatting or style fixes, renaming without behavior change, adding badges or metadata, updating .gitignore or editor configs.

INFORMATIONAL — Trivial changes: fixing typos, whitespace adjustments, comment rewording, version bumps in non-critical files, adding blank lines.

IMPORTANT: Do NOT default to LOW or INFORMATIONAL. Carefully evaluate the actual scope and impact. Most code changes that add or modify functionality should be MEDIUM or higher. Use the full range of the scale.
"""

BASE_INSTRUCTIONS = """
Return only a raw JSON object with no markdown formatting. The JSON must have these exact keys:

"issue_title": string — include severity prefix like [CRITICAL], [HIGH], [ELEVATED], [MEDIUM], [MODERATE], [LOW], or [INFO] at the start,
"severity": string — one of: critical, high, elevated, medium, moderate, low, informational,
"issue_body": string — must include these sections:
  ## Problem
  (clear description with exact file paths and line numbers if known)

  ## Code Reference
  (the exact problematic code snippet or the key changed code)

  ## Suggested Fix
  (concrete code or steps to fix — or "No action required" for informational changes)

  ## Permalink
  (placeholder: PUT_PERMALINK_HERE — will be replaced automatically)

"labels": list of strings — standard GitHub labels plus the severity level,
"affected_file": string — the most relevant filename from the diff (or "" if unknown),
"affected_line": integer — approximate line number of the issue (or 1 if unknown),
"summary": string — 2-3 sentence plain-English summary for the PR comment

The issue_title, issue_body and summary MUST be written entirely in English.
"""

#: Prompt personas keyed by role; selected via labels or auto-detection.
PROMPT_ROLES = {
    "security": (
        "Act as a Strict Security Auditor. Perform a deep security audit "
        "(OWASP Top 10, CWE patterns). Find real vulnerabilities with exact "
        "file/line references. Check for exposed secrets, injection vectors, "
        "broken auth, insecure deserialization, and misconfigurations."
    ),
    "review": (
        "Act as a Strict Code Reviewer. Analyze code quality using SOLID, DRY, "
        "and KISS principles. Point to exact lines that violate these principles. "
        "Evaluate naming, error handling, and separation of concerns."
    ),
    "qa": (
        "Act as a QA Engineer. Identify edge cases, missing test coverage, "
        "untested error paths, and potential regressions. Reference exact "
        "functions and lines that need tests."
    ),
    "perf": (
        "Act as a Performance Expert. Analyze algorithmic complexity, identify "
        "O(n²) patterns, unnecessary allocations, N+1 queries, blocking I/O, "
        "and missed caching opportunities. Reference exact lines."
    ),
    "pm": (
        "Act as a Product Manager. Generate user-facing Release Notes with "
        "clear impact descriptions. Focus on what changed for the end user, "
        "not implementation details."
    ),
    "deps": (
        "Act as a Security & Dependency Auditor. Analyze all new or changed "
        "dependencies: check for known vulnerabilities (CVEs), license "
        "compatibility (MIT/Apache/GPL), package size impact, maintenance "
        "status, and whether each dep is actively maintained. Reference exact "
        "file and line where each dependency is added or changed."
    ),
    "arch": (
        "Act as a Software Architect. Review changes for architectural issues: "
        "violation of separation of concerns, tight coupling, wrong layer "
        "dependencies, anti-patterns (God object, spaghetti logic, magic "
        "numbers, circular dependencies). Reference exact files and lines."
    ),
    "ci": (
        "Act as a DevOps/CI Engineer. Review the CI/CD pipeline changes for "
        "correctness, security (token permissions, secret exposure), efficiency "
        "(caching, parallelism, job dependencies), and best practices. Check "
        "for overly broad permissions, missing timeout limits, and potential "
        "race conditions in workflows."
    ),
    "docs": (
        "Act as a Technical Writer. Review the documentation changes for "
        "completeness, accuracy, clarity, and consistency. Check that code "
        "examples are correct, links are valid, and the structure is logical. "
        "Note any missing sections or outdated information."
    ),
    "frontend": (
        "Act as a Frontend Engineer. Review the UI/UX changes for accessibility "
        "(a11y), responsive design, performance (bundle size, render blocking), "
        "XSS risks in DOM manipulation, proper event handling, and browser "
        "compatibility. Reference exact files and lines."
    ),
    "backend": (
        "Act as a Senior Backend Engineer. Review the changes for correctness, "
        "error handling, input validation, resource management (file handles, "
        "connections), concurrency safety, and API contract compliance. "
        "Reference exact files and lines."
    ),
    "config": (
        "Act as a Configuration & Infrastructure Reviewer. Analyze the config "
        "changes for correctness, security implications (exposed ports, "
        "permissive CORS, debug mode in production), consistency across "
        "environments, and potential breaking changes for existing deployments."
    ),
    "general": (
        "Act as a Senior Software Engineer reviewing a colleague's changes. "
        "Provide a thorough assessment covering: what was changed and why, "
        "whether the changes introduce any risks or bugs, code quality, "
        "and the overall scope and impact on the project."
    ),
}

#: Maps commit-message bracket labels and PR labels to role keys.
LABEL_TO_ROLE = {
    "sec": "security", "security": "security", "audit": "security",
    "review": "review", "refactor": "review", "code-review": "review",
    "qa": "qa", "test": "qa", "testing": "qa",
    "perf": "perf", "performance": "perf", "optimize": "perf",
    "pm": "pm", "release": "pm", "product": "pm",
    "deps": "deps", "dependencies": "deps", "dep": "deps",
    "arch": "arch", "architecture": "arch",
    "ci": "ci", "devops": "ci", "pipeline": "ci", "workflow": "ci",
    "docs": "docs", "doc": "docs", "documentation": "docs",
    "frontend": "frontend", "ui": "frontend", "ux": "frontend", "css": "frontend",
    "backend": "backend", "api": "backend", "server": "backend",
    "config": "config", "infra": "config", "infrastructure": "config",
}

#: File-path keyword sets for auto-detecting the review role. Categories are
#: evaluated top-to-bottom; the first match wins.
SECURITY_DIFF_KEYWORDS = (
    "secret", "token", "password", "api_key", "apikey", "auth",
    "credential", "private_key", "access_key", "bearer",
    "vulnerability", "cve-", "injection", "xss", "csrf",
)
SECURITY_PATH_KEYWORDS = ("security", "auth", ".env", "secret")
DEPS_PATH_KEYWORDS = (
    "requirements", "package.json", "package-lock", "pipfile",
    "poetry.lock", "cargo.toml", "go.sum", "gemfile",
    "dependabot", "renovate",
)
CI_PATH_KEYWORDS = (
    ".github/workflows/", "jenkinsfile", ".gitlab-ci",
    ".circleci", "dockerfile", "docker-compose", ".github/actions/",
)
DOC_PATH_KEYWORDS = (
    "readme", "contributing", "changelog", "license",
    "docs/", "doc/", ".md", ".rst", ".txt",
)
FRONTEND_PATH_KEYWORDS = (
    ".html", ".css", ".jsx", ".tsx", ".vue", ".svelte",
    "frontend/", "public/", "static/", "assets/",
)
FRONTEND_DIFF_KEYWORDS = (
    "classname", "style=", "onclick", "addeventlistener",
    "document.get", "innerhtml", "appendchild",
)
BACKEND_PATH_KEYWORDS = (
    ".py", ".go", ".java", ".rb", ".rs", ".php",
    "api/", "server/", "backend/", "lib/", "src/",
)
CONFIG_PATH_KEYWORDS = (
    ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
    ".json", ".env",
)


# ---------------------------------------------------------------------------
# Environment and GitHub plumbing
# ---------------------------------------------------------------------------

def require_env(name: str) -> str:
    """Read a mandatory environment variable or abort with a clear message."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Required environment variable {name} is not set.")
    return value


def parse_allowed_users(raw: str) -> list:
    """Normalize the comma-separated allow-list into lowercase logins."""
    return [entry.strip().lower() for entry in raw.split(",") if entry.strip()]


def connect_repo(gh_token: str, repo_name: str) -> Repository:
    """Authenticate against GitHub and resolve the target repository."""
    gh = Github(auth=Auth.Token(gh_token))
    return gh.get_repo(repo_name)


# ---------------------------------------------------------------------------
# Event collection
# ---------------------------------------------------------------------------

def collect_diff(files, char_limit: int) -> tuple:
    """Accumulate per-file patches, stopping once ``char_limit`` is exceeded.

    Returns:
        A ``(changed_files, diff_text)`` tuple. When the limit is hit, the
        diff is marked as truncated so the model knows context is partial.
    """
    changed_files = []
    diff_parts = []
    size = 0
    for file in files:
        changed_files.append(file.filename)
        chunk = f"File: {file.filename}\nPatch:\n{file.patch}\n\n"
        size += len(chunk)
        diff_parts.append(chunk)
        if size > char_limit:
            diff_parts.append("\n[Diff truncated...]")
            break
    return changed_files, "".join(diff_parts)


def collect_push_event(repo: Repository, allowed_users: list) -> Optional[ChangeEvent]:
    """Build a ChangeEvent for a push, or None when the actor is not allowed."""
    commit_sha = require_env("COMMIT_SHA")
    actor_login = os.environ.get("GITHUB_ACTOR", "").strip().lower()
    if actor_login not in allowed_users:
        print(f"Action performed by {actor_login}, not in allowed list. Skipping.")
        return None

    commit = repo.get_commit(commit_sha)
    message = commit.commit.message

    pr_match = re.search(r"\(#(\d+)\)", message)
    dedup_key = f"PR #{pr_match.group(1)}" if pr_match else f"commit:{commit_sha[:7]}"

    changed_files, diff_text = collect_diff(commit.files, PUSH_DIFF_CHAR_LIMIT)
    trigger_labels = [match.lower() for match in re.findall(r"\[(.*?)]", message)]

    return ChangeEvent(
        dedup_key=dedup_key,
        context=f"Commit Message: {message}",
        diff_text=diff_text,
        changed_files=changed_files,
        trigger_labels=trigger_labels,
    )


def collect_pr_event(repo: Repository, allowed_users: list) -> Optional[ChangeEvent]:
    """Build a ChangeEvent for a pull request, or None when not allowed."""
    pr_number = int(require_env("PR_NUMBER"))
    pr = repo.get_pull(pr_number)

    author_login = pr.user.login.strip().lower()
    if author_login not in allowed_users:
        print(f"PR author {author_login} not in allowed list. Skipping.")
        return None

    changed_files, diff_text = collect_diff(pr.get_files(), PR_DIFF_CHAR_LIMIT)

    return ChangeEvent(
        dedup_key=f"PR #{pr_number}",
        context=f"PR Title: {pr.title}\nPR Body: {pr.body}",
        diff_text=diff_text,
        changed_files=changed_files,
        trigger_labels=[label.name.lower() for label in pr.labels],
        pr_ref=pr,
    )


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def issue_already_exists(repo: Repository, dedup_key: str) -> bool:
    """Scan recent issues (bounded) for one that embeds the dedup key."""
    recent = itertools.islice(repo.get_issues(state="all"), DEDUP_SCAN_ISSUE_LIMIT)
    for issue in recent:
        if dedup_key in (issue.body or ""):
            print(f"Issue for {dedup_key} already exists (#{issue.number}), skipping.")
            return True
    return False


def was_already_closed(repo: Repository, title_keyword: str) -> bool:
    """Return whether a similar issue title already exists in closed issues."""
    if not title_keyword:
        return False
    keyword = title_keyword.lower()
    recent = itertools.islice(repo.get_issues(state="closed"), DEDUP_SCAN_ISSUE_LIMIT)
    for issue in recent:
        if keyword in (issue.title or "").lower():
            print(f"Similar closed issue found: #{issue.number} — skipping.")
            return True
    return False


def build_permalink(repo_name: str, event: ChangeEvent, filename: str, line: int = 1) -> str:
    """Build a GitHub blob permalink for a file at the analyzed revision."""
    sha = os.environ.get("COMMIT_SHA") or ""
    if not sha and event.pr_ref:
        sha = event.pr_ref.head.sha
    return f"https://github.com/{repo_name}/blob/{sha}/{filename}#L{line}"


# ---------------------------------------------------------------------------
# Role resolution
# ---------------------------------------------------------------------------

def detect_change_type(files: list, diff: str) -> str:
    """Infer the review role from changed file paths and diff content.

    Args:
        files: Changed file paths.
        diff: Accumulated diff text.

    Returns:
        A role key present in ``PROMPT_ROLES``.
    """
    files_lower = [name.lower() for name in files]
    diff_lower = diff.lower()

    def any_path(keywords) -> bool:
        return any(keyword in path for path in files_lower for keyword in keywords)

    if any(keyword in diff_lower for keyword in SECURITY_DIFF_KEYWORDS) or any_path(SECURITY_PATH_KEYWORDS):
        return "security"
    if any_path(DEPS_PATH_KEYWORDS):
        return "deps"
    if any_path(CI_PATH_KEYWORDS):
        return "ci"
    # A change is "docs" only when every touched file is documentation.
    if files_lower and all(any(keyword in path for keyword in DOC_PATH_KEYWORDS) for path in files_lower):
        return "docs"
    if any_path(FRONTEND_PATH_KEYWORDS) or any(keyword in diff_lower for keyword in FRONTEND_DIFF_KEYWORDS):
        return "frontend"
    if any_path(BACKEND_PATH_KEYWORDS):
        return "backend"
    if any_path(CONFIG_PATH_KEYWORDS):
        return "config"
    return "general"


def resolve_role(event: ChangeEvent) -> str:
    """Pick the prompt role: explicit labels win, otherwise auto-detect."""
    for label in event.trigger_labels:
        if label in LABEL_TO_ROLE:
            return LABEL_TO_ROLE[label]
    role = detect_change_type(event.changed_files, event.diff_text)
    print(f"Auto-detected change type: {role}")
    return role


def build_prompt(role_key: str, event: ChangeEvent) -> str:
    """Assemble the full review prompt for the resolved role."""
    role_instruction = PROMPT_ROLES.get(role_key, PROMPT_ROLES["general"])
    return f"""{role_instruction}

Do NOT invent problems that do not exist in the diff. Base your analysis strictly on what you see.
{SEVERITY_GUIDE}
Context: {event.context}
Changed files: {', '.join(event.changed_files)}
Changes: {event.diff_text}
{BASE_INSTRUCTIONS}"""


# ---------------------------------------------------------------------------
# Model interaction
# ---------------------------------------------------------------------------

def call_model(prompt: str, model_token: str) -> Optional[dict]:
    """Send a review prompt to the hosted model and parse the JSON reply.

    Retries transient failures with a fixed delay. Returns ``None`` when all
    attempts fail; callers treat that as a benign skip.
    """
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {model_token}",
    }
    payload = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a professional software auditor. Always return "
                    "valid JSON only. No markdown, no explanation, just the "
                    "JSON object."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "model": MODEL_NAME,
        "temperature": MODEL_TEMPERATURE,
    }

    for attempt in range(1, MODEL_RETRIES + 1):
        try:
            response = requests.post(
                ENDPOINT, headers=headers, json=payload, timeout=MODEL_TIMEOUT_SECONDS
            )
            response.raise_for_status()
            raw = response.json()["choices"][0]["message"]["content"].strip()
            raw = re.sub(r"^```json\s*|```$", "", raw, flags=re.MULTILINE).strip()
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("Model response is not a JSON object.")
            return parsed
        except (requests.RequestException, ValueError, KeyError, IndexError) as error:
            print(f"Attempt {attempt}/{MODEL_RETRIES} failed: {error}")
            if attempt < MODEL_RETRIES:
                time.sleep(MODEL_RETRY_DELAY_SECONDS)

    print("All model attempts failed. Exiting gracefully.")
    return None


# ---------------------------------------------------------------------------
# Publishing results
# ---------------------------------------------------------------------------

def publish_issue(repo: Repository, repo_name: str, result: dict, event: ChangeEvent, role_key: str) -> int:
    """Create the analysis issue and return its number."""
    title = str(result.get("issue_title", "")).strip() or f"[INFO] Analysis for {event.dedup_key}"
    body = str(result.get("issue_body", ""))

    affected_file = str(result.get("affected_file", ""))
    try:
        affected_line = int(result.get("affected_line", 1))
    except (TypeError, ValueError):
        affected_line = 1

    if affected_file:
        permalink = build_permalink(repo_name, event, affected_file, affected_line)
    else:
        permalink = "_No specific file identified_"
    body = body.replace("PUT_PERMALINK_HERE", permalink)

    actor_name = os.environ.get("GITHUB_ACTOR", "unknown")
    body += (
        f"\n\n---\n*Generated from {event.dedup_key} | Auto-detected role: "
        f"`{role_key}` | Processed by actor: {actor_name}*"
    )

    severity = str(result.get("severity", DEFAULT_SEVERITY)).lower()
    labels = result.get("labels")
    if not isinstance(labels, list):
        labels = []
    labels = [str(label) for label in labels]
    labels.append(SEVERITY_LABELS.get(severity, SEVERITY_LABELS[DEFAULT_SEVERITY]))

    issue = repo.create_issue(title=title, body=body, labels=sorted(set(labels)))
    print(f"Created issue #{issue.number}: {issue.title}")
    return issue.number


def post_pr_summary(pr: PullRequest, result: dict, role_key: str, issue_number: int) -> None:
    """Post the short AI summary as a comment on the analyzed pull request."""
    summary = str(result.get("summary", "")).strip()
    if not summary:
        return
    severity = str(result.get("severity", DEFAULT_SEVERITY)).lower()
    comment = (
        f"### AI Analysis Summary\n\n"
        f"{summary}\n\n"
        f"**Severity:** `{severity.upper()}` | **Role:** `{role_key}`\n\n"
        f"Full details: #{issue_number}"
    )
    pr.create_issue_comment(comment)
    print(f"Posted summary comment to PR #{pr.number}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    """Route the triggering event through analysis and publish the outcome."""
    gh_token = require_env("GITHUB_TOKEN")
    model_token = require_env("GH_MODELS_TOKEN")
    repo_name = require_env("REPOSITORY")
    event_name = require_env("EVENT_NAME")
    allowed_users = parse_allowed_users(os.environ.get("ALLOWED_USER", ""))

    repo = connect_repo(gh_token, repo_name)

    if event_name == "push":
        event = collect_push_event(repo, allowed_users)
    elif event_name == "pull_request":
        event = collect_pr_event(repo, allowed_users)
    else:
        print(f"Unsupported event '{event_name}'. Skipping.")
        return 0

    if event is None:
        return 0

    if len(event.diff_text.strip()) < MIN_DIFF_CHARS:
        print("Diff too small to analyze. Skipping.")
        return 0

    if issue_already_exists(repo, event.dedup_key):
        return 0

    role_key = resolve_role(event)
    result = call_model(build_prompt(role_key, event), model_token)
    if result is None:
        return 0

    if was_already_closed(repo, str(result.get("issue_title", ""))[:40]):
        return 0

    issue_number = publish_issue(repo, repo_name, result, event, role_key)
    if event.pr_ref:
        post_pr_summary(event.pr_ref, result, role_key, issue_number)
    return 0


if __name__ == "__main__":
    sys.exit(main())
