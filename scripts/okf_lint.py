#!/usr/bin/env python3
"""OKF v0.1 linter for the Hermes/Jarvis knowledge bundles.

Validates Open Knowledge Format conformance over a bundle directory:

* every non-reserved ``.md`` file has parseable YAML frontmatter with a
  non-empty ``type`` field (OKF hard requirement),
* reserved files (``index.md`` / ``log.md``) follow their structural rules,
* bundle-absolute and relative markdown links resolve (broken = warning, per
  the spec's permissive-consumption rule; ``--strict-links`` promotes to error),
* nothing under the wiki directory leaks credentials (deny-pattern scan;
  a hit is a hard error with a distinct exit code so crons can alarm loudly),
* optional index coverage / index regeneration helpers.

Dependency-light: uses PyYAML when available, else a minimal built-in parser
sufficient for our flat frontmatter. Runs on Windows (local workspace) and on
server20 (``~/.hermes``). See ``wiki/conventions.md`` for the type vocabulary
and tag taxonomy this enforces.

Exit codes: 0 = clean, 1 = conformance error(s), 2 = sensitive-content hit.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

try:  # Fast path — both pythons in this ecosystem ship PyYAML.
    import yaml  # type: ignore

    _HAVE_YAML = True
except Exception:  # pragma: no cover - fallback exercised only without PyYAML
    _HAVE_YAML = False


RESERVED_NAMES = ("index.md", "log.md")

# Directories never worth walking regardless of .okfignore.
BUILTIN_IGNORES = (
    ".git/",
    ".hg/",
    ".svn/",
    "node_modules/",
    "__pycache__/",
    ".pytest_cache/",
    ".venv/",
    ".venv-crypto/",
    "venv/",
)

DATE_HEADING_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\b")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")

# Link schemes that are intentionally non-resolvable (external or cross-bundle).
UNRESOLVABLE_SCHEMES = (
    "http://",
    "https://",
    "mailto:",
    "jarvis://",       # cross-bundle: server bundle target
    "hermes-local://",  # cross-bundle: local workspace target
    "#",                # in-page anchor
)

# Credential deny-patterns applied to every file under the wiki directory.
SENSITIVE_PATTERNS: Tuple[Tuple[str, "re.Pattern[str]"], ...] = (
    ("password assignment", re.compile(r"(?i)\bpassword\s*[:=]\s*\S")),
    ("secret/token assignment",
     re.compile(r"(?i)\b(api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)\s*[:=]\s*\S")),
    ("private key block", re.compile(r"BEGIN [A-Z ]*PRIVATE KEY")),
    ("github token", re.compile(r"\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.")),
    ("google oauth client id", re.compile(r"\b[0-9]+-[a-z0-9]{20,}\.apps\.googleusercontent\.com")),
)

# Inline opt-out for a deny-pattern false positive. Put `okf-allow` in an HTML
# comment on the offending line or the line above, with a reason.
OKF_ALLOW_RE = re.compile(r"okf-allow")

SEVERITY_ERROR = "ERROR"
SEVERITY_WARN = "WARN"


@dataclass(frozen=True)
class Finding:
    """A single lint result anchored to a file (and optional line)."""

    severity: str
    path: str
    message: str
    line: Optional[int] = None

    def render(self) -> str:
        loc = self.path if self.line is None else f"{self.path}:{self.line}"
        return f"{self.severity:5} {loc}  {self.message}"


# ── Frontmatter parsing ─────────────────────────────────────────────────────


def split_frontmatter(text: str) -> Tuple[Optional[str], str]:
    """Return (raw_frontmatter, body). raw_frontmatter is None if absent."""
    if not text.startswith("---"):
        return None, text
    match = re.search(r"\n---[ \t]*\r?\n", text[3:])
    if not match:
        return None, text
    raw = text[3 : match.start() + 3]
    body = text[match.end() + 3 :]
    return raw, body


def _minimal_yaml(raw: str) -> Dict[str, Any]:
    """Parse flat frontmatter without PyYAML.

    Handles ``key: value``, quoted scalars, inline ``[a, b]`` lists, and
    block ``- item`` lists. Raises ValueError on structurally broken input so
    the caller reports it as unparseable.
    """
    result: Dict[str, Any] = {}
    current_key: Optional[str] = None
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if stripped.startswith("- ") and current_key is not None:
            result.setdefault(current_key, [])
            if isinstance(result[current_key], list):
                result[current_key].append(stripped[2:].strip().strip("'\""))
            continue
        if ":" not in stripped:
            raise ValueError(f"unparseable frontmatter line: {line!r}")
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        current_key = key
        if value == "":
            result[key] = ""
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            result[key] = [v.strip().strip("'\"") for v in inner.split(",") if v.strip()] if inner else []
        else:
            result[key] = value.strip("'\"")
    return result


def parse_frontmatter(raw: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Parse a frontmatter block. Returns (mapping, error_message)."""
    if _HAVE_YAML:
        try:
            parsed = yaml.safe_load(raw)
        except Exception as exc:  # noqa: BLE001 - report any YAML failure
            return None, f"YAML parse error: {exc}"
        if parsed is None:
            return {}, None
        if not isinstance(parsed, dict):
            return None, "frontmatter is not a mapping"
        return parsed, None
    try:
        return _minimal_yaml(raw), None
    except ValueError as exc:
        return None, str(exc)


# ── Ignore handling ─────────────────────────────────────────────────────────


def load_ignore_patterns(root: Path, wiki_dir: str) -> Tuple[List[str], List[str]]:
    """Load (ignore, negate) glob patterns from ``<wiki_dir>/.okfignore``."""
    ignores: List[str] = list(BUILTIN_IGNORES)
    negations: List[str] = []
    ignore_file = root / wiki_dir / ".okfignore"
    if ignore_file.is_file():
        for line in ignore_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("!"):
                negations.append(line[1:].strip())
            else:
                ignores.append(line)
    return ignores, negations


def _matches(rel_posix: str, pattern: str) -> bool:
    pat = pattern.rstrip("/")
    if fnmatch.fnmatch(rel_posix, pat):
        return True
    # Directory-style pattern: match the dir itself and everything beneath it.
    if fnmatch.fnmatch(rel_posix, pat + "/*") or rel_posix == pat:
        return True
    return any(part == pat for part in rel_posix.split("/"))


def is_ignored(rel_posix: str, ignores: List[str], negations: List[str]) -> bool:
    if any(_matches(rel_posix, neg) for neg in negations):
        return False
    return any(_matches(rel_posix, pat) for pat in ignores)


def iter_markdown(root: Path, ignores: List[str], negations: List[str]) -> Iterator[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        kept = []
        for d in dirnames:
            rel = f"{d}/" if rel_dir == "." else f"{rel_dir}/{d}/"
            if not is_ignored(rel.rstrip("/"), ignores, negations):
                kept.append(d)
        dirnames[:] = kept
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            if is_ignored(rel, ignores, negations):
                continue
            yield root / rel


# ── Concept / reserved-file checks ──────────────────────────────────────────


def check_concept(root: Path, path: Path) -> List[Finding]:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    raw, _ = split_frontmatter(text)
    if raw is None:
        return [Finding(SEVERITY_ERROR, rel, "missing YAML frontmatter (no leading '---' block)")]
    fm, err = parse_frontmatter(raw)
    if err is not None or fm is None:
        return [Finding(SEVERITY_ERROR, rel, f"unparseable frontmatter ({err})")]
    findings: List[Finding] = []
    type_val = fm.get("type")
    if not isinstance(type_val, str) or not type_val.strip():
        findings.append(Finding(SEVERITY_ERROR, rel, "frontmatter missing non-empty 'type'"))
    for recommended in ("title", "description", "timestamp"):
        if not fm.get(recommended):
            findings.append(Finding(SEVERITY_WARN, rel, f"frontmatter missing recommended '{recommended}'"))
    return findings


def check_index(root: Path, path: Path) -> List[Finding]:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    raw, _ = split_frontmatter(text)
    if raw is None:
        return []
    fm, err = parse_frontmatter(raw)
    if err is not None or fm is None:
        return [Finding(SEVERITY_WARN, rel, f"index.md frontmatter unparseable ({err})")]
    allowed = {"okf_version"}
    extra = set(fm) - allowed
    if extra:
        return [Finding(SEVERITY_WARN, rel,
                        f"index.md should carry no frontmatter except okf_version (found: {sorted(extra)})")]
    return []


def check_log(root: Path, path: Path) -> List[Finding]:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    dates: List[str] = []
    for line in text.splitlines():
        m = DATE_HEADING_RE.match(line.strip())
        if m:
            dates.append(m.group(1))
    findings: List[Finding] = []
    if dates and dates != sorted(dates, reverse=True):
        findings.append(Finding(SEVERITY_WARN, rel, "log.md date headings are not newest-first"))
    return findings


# ── Link checking ───────────────────────────────────────────────────────────


def _strip_code(text: str) -> str:
    """Remove fenced blocks and inline-code spans so example links inside them
    are not mistaken for real links."""
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`\n]*`", "", text)
    return text


def collect_links(text: str) -> List[str]:
    return [m.group(1).split(" ")[0].strip() for m in LINK_RE.finditer(_strip_code(text))]


def resolve_link(root: Path, source: Path, href: str) -> bool:
    target = href.split("#", 1)[0]
    if not target:
        return True
    if href.startswith("/"):
        candidate = root / target.lstrip("/")
    else:
        candidate = (source.parent / target).resolve()
    return candidate.exists()


def check_links(root: Path, path: Path, strict: bool) -> List[Finding]:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    findings: List[Finding] = []
    for href in collect_links(text):
        if href.startswith(UNRESOLVABLE_SCHEMES) or "://" in href:
            continue
        if not resolve_link(root, path, href):
            sev = SEVERITY_ERROR if strict else SEVERITY_WARN
            findings.append(Finding(sev, rel, f"broken link: {href}"))
    return findings


# ── Sensitive-content scan (wiki only) ──────────────────────────────────────


def scan_sensitive(root: Path, wiki_dir: str,
                   ignores: Optional[List[str]] = None,
                   negations: Optional[List[str]] = None) -> List[Finding]:
    """Deny-pattern scan over the bundle.

    Honours ``.okfignore``: a path excluded from the bundle is not part of the
    published knowledge tree, so scanning it produces a finding that can never be
    actioned (e.g. a deliberately local-only, gitignored credentials runbook).
    Leaving those in trains readers to ignore the linter.
    """
    wiki_root = root / wiki_dir
    if not wiki_root.is_dir():
        return []
    ignores = ignores or []
    negations = negations or []
    findings: List[Finding] = []
    for dirpath, dirnames, filenames in os.walk(wiki_root):
        dirnames.sort()
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        dirnames[:] = [
            d for d in dirnames
            if not is_ignored(f"{rel_dir}/{d}" if rel_dir != "." else d, ignores, negations)
        ]
        for name in sorted(filenames):
            fpath = Path(dirpath) / name
            rel = fpath.relative_to(root).as_posix()
            if is_ignored(rel, ignores, negations):
                continue
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except Exception:  # noqa: BLE001 - binary/unreadable files are skipped
                continue
            raw, _ = split_frontmatter(text)
            if raw is not None:
                fm, _ = parse_frontmatter(raw)
                tags = (fm or {}).get("tags") or []
                if isinstance(tags, list) and any(str(t).strip().lower() == "sensitive" for t in tags):
                    findings.append(Finding(SEVERITY_ERROR, rel, "wiki file tagged 'sensitive' — must not live in wiki/"))
            lines = text.splitlines()
            for label, pattern in SENSITIVE_PATTERNS:
                for i, line in enumerate(lines, start=1):
                    if not pattern.search(line):
                        continue
                    # Explicit per-line opt-out. Prose docs legitimately *describe*
                    # credential fields ("Password: MD5-hashed before sending"), and
                    # the deny-patterns cannot tell that from a real value. An inline
                    # marker keeps the escape auditable instead of silently widening
                    # the regex or ignoring the whole file.
                    if OKF_ALLOW_RE.search(line) or (
                        i >= 2 and OKF_ALLOW_RE.search(lines[i - 2])
                    ):
                        continue
                    findings.append(Finding(SEVERITY_ERROR, rel, f"possible {label} in wiki/", i))
                    break
    return findings


# ── Index coverage / generation ─────────────────────────────────────────────


def _frontmatter_of(path: Path) -> Dict[str, Any]:
    raw, _ = split_frontmatter(path.read_text(encoding="utf-8", errors="replace"))
    if raw is None:
        return {}
    fm, _ = parse_frontmatter(raw)
    return fm or {}


def check_index_coverage(root: Path, concepts: List[Path]) -> List[Finding]:
    referenced: set[str] = set()
    for dirpath, _dirnames, filenames in os.walk(root):
        if "index.md" not in filenames:
            continue
        index_path = Path(dirpath) / "index.md"
        for href in collect_links(index_path.read_text(encoding="utf-8", errors="replace")):
            if href.startswith(UNRESOLVABLE_SCHEMES) or "://" in href:
                continue
            target = href.split("#", 1)[0]
            if href.startswith("/"):
                referenced.add((root / target.lstrip("/")).resolve().as_posix())
            else:
                referenced.add((index_path.parent / target).resolve().as_posix())
    findings: List[Finding] = []
    for concept in concepts:
        if concept.resolve().as_posix() not in referenced:
            findings.append(Finding(SEVERITY_WARN, concept.relative_to(root).as_posix(),
                                    "concept not referenced by any index.md"))
    return findings


def generate_index(root: Path, directory: Path) -> str:
    lines: List[str] = []
    for child in sorted(directory.iterdir()):
        if child.name in RESERVED_NAMES or child.name.startswith("."):
            continue
        if child.is_dir():
            lines.append(f"* [{child.name}/]({child.name}/) - ")
        elif child.suffix == ".md":
            fm = _frontmatter_of(child)
            title = fm.get("title") or child.stem
            desc = fm.get("description") or ""
            rel = child.relative_to(root).as_posix()
            lines.append(f"* [{title}](/{rel}) - {desc}")
    return "\n".join(lines)


# ── Driver ──────────────────────────────────────────────────────────────────


def run_lint(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"ERROR: root not found: {root}", file=sys.stderr)
        return 1

    ignores, negations = load_ignore_patterns(root, args.wiki_dir)

    if args.gen_index:
        target_dir = (root / args.gen_index).resolve()
        print(generate_index(root, target_dir))
        return 0

    if args.wiki_only:
        scan_root = root / args.wiki_dir
        concepts = [p for p in iter_markdown(scan_root, ignores, negations)
                    if p.name not in RESERVED_NAMES] if scan_root.is_dir() else []
    else:
        concepts = [p for p in iter_markdown(root, ignores, negations) if p.name not in RESERVED_NAMES]

    findings: List[Finding] = []
    for path in concepts:
        findings.extend(check_concept(root, path))
        findings.extend(check_links(root, path, args.strict_links))

    reserved_root = (root / args.wiki_dir) if args.wiki_only else root
    for dirpath, dirnames, filenames in os.walk(reserved_root):
        dirnames.sort()
        rel_dir = Path(dirpath).relative_to(root).as_posix()
        for name in filenames:
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            if is_ignored(rel, ignores, negations):
                continue
            if name == "index.md":
                findings.extend(check_index(root, Path(dirpath) / name))
            elif name == "log.md":
                findings.extend(check_log(root, Path(dirpath) / name))

    if args.check_index:
        findings.extend(check_index_coverage(root, concepts))

    sensitive = scan_sensitive(root, args.wiki_dir, ignores, negations)

    errors = [f for f in findings if f.severity == SEVERITY_ERROR]
    warnings = [f for f in findings if f.severity == SEVERITY_WARN]

    if not args.quiet:
        for f in sorted(warnings, key=lambda x: (x.path, x.line or 0)):
            print(f.render())
    for f in sorted(errors, key=lambda x: (x.path, x.line or 0)):
        print(f.render())
    for f in sensitive:
        print(f.render())

    print(
        f"\nokf_lint: {len(concepts)} concept file(s), "
        f"{len(errors)} error(s), {len(warnings)} warning(s), "
        f"{len(sensitive)} sensitive hit(s).",
        file=sys.stderr,
    )

    if sensitive:
        return 2
    if errors:
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="OKF v0.1 linter for the Hermes/Jarvis bundles.")
    p.add_argument("--root", required=True, help="bundle root directory")
    p.add_argument("--wiki-dir", default="wiki", help="wiki subdirectory name (default: wiki)")
    p.add_argument("--wiki-only", action="store_true", help="lint only under the wiki directory")
    p.add_argument("--strict-links", action="store_true", help="treat broken links as errors")
    p.add_argument("--check-index", action="store_true", help="warn on concepts absent from any index.md")
    p.add_argument("--gen-index", metavar="DIR", help="print regenerated index bullets for DIR and exit")
    p.add_argument("--quiet", action="store_true", help="suppress warnings (errors still shown)")
    return p


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    return run_lint(args)


if __name__ == "__main__":
    raise SystemExit(main())
