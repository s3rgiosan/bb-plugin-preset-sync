# Changelog

## 0.2.2

- Restore `plugin@marketplace` entries through BB's catalog API instead of
  treating them as machine-local package paths.
- Confirm the resolved source from the catalog install plan before installing
  third-party marketplace plugins.

## 0.2.1

- Show directional `↓ remote` and `↑ local` change counts in the BB sidebar.
- List the exact pull and push changes with explicit actions on the Preset Sync page.
- Add a configurable background comparison interval from one to sixty minutes,
  including an Off option.
- Keep the background indicator silent while the preset is fully synchronized.

## 0.2.0

- Publish a generic configuration with no user-specific repository default.
- Add a dedicated Preset Sync page to the BB sidebar.
- Explain first-time setup in the UI and CLI.
- Allow `push --fresh` to initialize an existing Git repository that has no
  preset files yet.
- Add frontend registration coverage and public-release documentation.

## 0.1.3

- Harden Git input validation, secret filtering, path filtering, and preset
  filesystem handling.
