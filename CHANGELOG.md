# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.1.5](https://github.com/jgchk/music-importer/compare/v0.1.4...v0.1.5) (2026-07-19)


### Features

* **verdicts:** emit signed release.verdict webhooks via reject-and-retry-download ([b3487a7](https://github.com/jgchk/music-importer/commit/b3487a7f3d7a0c55bb7e79008e889663ad945c5f))

## [0.1.4](https://github.com/jgchk/music-importer/compare/v0.1.3...v0.1.4) (2026-07-19)


### Bug Fixes

* **bridge:** reserve stdout exclusively for the contract JSON ([28bd814](https://github.com/jgchk/music-importer/commit/28bd8145375612c51043033b033208c8c2fce719))

## [0.1.3](https://github.com/jgchk/music-importer/compare/v0.1.2...v0.1.3) (2026-07-19)


### Bug Fixes

* **bridge:** guarantee the musicbrainz candidate source loads ([5b11a6c](https://github.com/jgchk/music-importer/commit/5b11a6c84ad41c5328ffe9ebea55864125cd4ef0))

## [0.1.2](https://github.com/jgchk/music-importer/compare/v0.1.1...v0.1.2) (2026-07-19)


### Features

* **intake:** accept signed acquisition.fulfilled webhooks from music-downloader ([ce50576](https://github.com/jgchk/music-importer/commit/ce50576f8768fd66fe6681736efbed849fd9aa19))

## [0.1.1](https://github.com/jgchk/music-importer/compare/v0.1.0...v0.1.1) (2026-07-19)


### Features

* **import:** bootstrap the import core — aggregate, beets bridge, review queue, HTTP+MCP ([4732968](https://github.com/jgchk/music-importer/commit/47329688f2aca82af4174b33d1335834202459f5))

## 0.1.0 (2026-07-19)

Initial scaffold: layered + hexagonal skeleton, quality gate (format/lint/typecheck/build/tests @ 100% coverage), release pipeline, Docker build, out-of-process E2E tier, OpenSpec workflow.
