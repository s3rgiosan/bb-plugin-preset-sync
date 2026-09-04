# Security

Preset Sync handles configuration that may control full-trust BB plugins. Review
`bb preset diff` before applying a preset from a repository you do not control.

The plugin excludes declared secret settings, credential-like keys and values,
provider sessions, runtime data, and machine-local paths from captures. Git
credentials are passed to Git through process-local configuration and are
redacted from reported Git errors.

To report a vulnerability, use GitHub's private vulnerability reporting for
this repository when available. Otherwise, contact the maintainer through the
GitHub profile without including credentials or exploit details in a public
issue.
