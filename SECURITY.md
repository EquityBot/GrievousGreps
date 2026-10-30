# Security policy

## Supported versions

Security fixes are applied to the latest version on the default branch.

## Filesystem Safety

Graft refuses to write through a symlink planted in a repository or its output
directory. The checks run before each write, so they do not cover a link swapped
in between the check and the write: concurrent mutation by a process already
running on the machine is out of scope, because that process needs no such route.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
https://github.com/EquityBot/GrievousGreps/security/advisories/new. Do not open
an issue for a suspected security vulnerability. Include a clear description,
reproduction steps, impact and any suggested mitigation.

Use public repositories or fabricated fixtures only. Do not submit private code,
credentials, access tokens, secrets or `.env` content.
