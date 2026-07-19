## MODIFIED Requirements

### Requirement: Imports and reviews are exposed over HTTP and MCP from one contract source

The system SHALL expose the import lifecycle over a versioned HTTP API (`/api/v1/imports`) and an MCP server offering the same operations: submit an import (directory path + optional hints), list imports, get an import (with its history), list pending reviews, and resolve a review by verb — the verb union including reject-and-retry-download, whose missing-precondition refusal (no retained candidate) SHALL surface as a precise, schema-shaped error on both surfaces. Both surfaces SHALL be generated from a single set of zod contract schemas, and the HTTP API SHALL publish its OpenAPI document. Changes to the public surface SHALL be additive-only within the version.

#### Scenario: Manual import end to end over HTTP

- **GIVEN** a directory of music files
- **WHEN** it is submitted over HTTP
- **THEN** the response returns an import ID and status URL, and the import proceeds through the lifecycle observable at that URL

#### Scenario: An agent resolves a review over MCP

- **GIVEN** a pending match-review
- **WHEN** an MCP client lists pending reviews and resolves one with a listed candidate
- **THEN** the resolution is the same operation the HTTP surface offers, and the import proceeds to applied

#### Scenario: Submission validation is schema-driven

- **GIVEN** a submission missing its directory path
- **WHEN** it is posted
- **THEN** it is rejected by schema validation with a precise error, identically on both surfaces

#### Scenario: The retry verb's refusal is contract-shaped on both surfaces

- **GIVEN** a review whose import retains no delivered candidate
- **WHEN** reject-and-retry-download is submitted over HTTP or MCP
- **THEN** the refusal names the missing retained-candidate precondition in the documented error shape, identically on both surfaces
