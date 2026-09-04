# BB Preset Sync

Preset Sync keeps portable BB plugins and settings aligned across computers
through a Git repository. It adds a **Preset Sync** page to the BB sidebar, a
section under **Settings → Plugins → Preset Sync**, and the `bb preset` command.

## Install

From the y5k marketplace:

```bash
bb marketplace add git:https://github.com/imyeskela/y5k-bb-marketplace.git@main
bb plugin install preset-sync@y5k --yes
```

Or install the tagged release directly:

```bash
bb plugin install git:https://github.com/imyeskela/bb-plugin-preset-sync.git@v0.2.1 --yes
```

## First setup

1. Create a Git repository for the preset. For a private GitHub repository,
   initialize it with a README so that the `main` branch exists.
2. Set **Preset repository** under **Settings → Plugins → Preset Sync**, or run:

   ```bash
   bb plugin config preset-sync set repositoryUrl https://github.com/OWNER/bb-preset.git
   ```

3. Make sure Git can authenticate. For GitHub, the usual setup is:

   ```bash
   gh auth login
   gh auth setup-git
   ```

   Alternatively, store a PAT in the secret **GitHub token** plugin setting.
   Secret settings are kept out of the frontend and are never captured.

4. Capture this computer and initialize or update the preset:

   ```bash
   bb preset push --fresh
   ```

On another computer, install the plugin, configure the same repository, preview
the changes, and apply them:

```bash
bb preset diff
bb preset pull --yes
```

`pull` without `--yes` only prints a preview and changes nothing. Pull is
additive: locally installed plugins that are absent from the preset are kept.

The sidebar indicator stays hidden while the local and remote presets match.
When they differ it shows `↓` for changes available from the remote preset and
`↑` for local changes available to push. Open Preset Sync to review every
change and choose a direction.

Background comparisons run every five minutes by default. Change
**Background check interval** under **Settings → Plugins → Preset Sync** to
`Off`, 1, 5, 10, 15, 30, or 60 minutes. A background check never pulls or
pushes automatically.

## Commands

```text
bb preset status
bb preset diff
bb preset capture
bb preset push
bb preset push --fresh
bb preset pull --yes
```

## Captured data

- installed plugins and enabled/disabled state;
- third-party marketplaces;
- general BB settings and experiment flags;
- keyboard shortcut overrides;
- selected theme and favicon color;
- non-secret plugin settings that pass additional safety checks.

The plugin never captures tokens, API keys, passwords, provider credentials,
sessions, threads, history, databases, runtime state, itself, local `path:`
plugins or marketplaces, or settings containing machine-local paths.

Applying a preset can install full-trust plugins and update BB configuration.
Only sync from a repository you control, inspect changes with `bb preset diff`,
and keep the repository private if its non-secret configuration is sensitive.

## Development

```bash
npm install --include=dev
npm run check
bb plugin install . --yes
```

The MIT-licensed source and prebuilt `dist/` artifacts are committed. BB
installs production dependencies and builds Git installations automatically;
users do not need to run `npm install` manually.
