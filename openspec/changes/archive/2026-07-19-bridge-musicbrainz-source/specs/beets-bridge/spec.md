## MODIFIED Requirements

### Requirement: The user's beets config is authoritative, with forced non-interactive session overrides

The bridge SHALL load the user's own beets configuration (path injectable) so library-defining behavior — directory, database, path formats, the plugin chain — is identical to manual CLI use, and SHALL unconditionally override a small documented set of session keys so no invocation can ever prompt, resume, or skip incrementally, regardless of what the config requests. The bridge SHALL likewise guarantee the MusicBrainz candidate source is loaded even when the user's plugin list omits it (configs written for beets versions where that source was built-in), without modifying the user's configuration file. The service SHALL validate the configuration at startup and fail loudly on an unusable one, and SHALL expose the effective merged configuration for inspection, including the effective plugin list.

#### Scenario: Library behavior matches manual CLI use

- **GIVEN** a user config with custom path formats and plugins
- **WHEN** the bridge imports a release
- **THEN** the release is filed and enriched exactly as a manual `beet import` would have

#### Scenario: An interactive config cannot hang the service

- **GIVEN** a user config that enables interactive behavior
- **WHEN** the bridge runs any verb
- **THEN** the session completes without prompting

#### Scenario: A pre-plugin-era plugin list still sources MusicBrainz candidates

- **GIVEN** a user config whose `plugins:` list omits `musicbrainz` because it was written for a beets where that source was built-in
- **WHEN** the bridge proposes candidates for a release
- **THEN** MusicBrainz candidates are produced exactly as if the plugin were listed
- **AND** the user's configuration file is not modified

#### Scenario: A config that already lists the source is unaffected

- **GIVEN** a user config whose `plugins:` list already contains `musicbrainz`
- **WHEN** the bridge bootstraps a session
- **THEN** the effective plugin list is exactly the user's list
