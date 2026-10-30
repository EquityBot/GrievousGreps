# Security Policy

## Supported Versions

Trail-code (formerly graft) is pre-1.0 and ships continuously from `main`. Security
fixes are made against the latest published npm release (`@trailhq/trail`, also
published as `@nanonets/graft`); older versions are not separately patched.

## Filesystem Safety

Graft refuses to write through a symlink planted in a repository or its output
directory. The checks run before each write, so they do not cover a link swapped
in between the check and the write: concurrent mutation by a process already
running on the machine is out of scope, because that process needs no such route.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/trailhq/Graft/security/advisories/new),
or email shrish@nanonets.com.

We'll acknowledge your report within 3 business days and aim to ship a fix or
mitigation within 30 days, depending on severity.
