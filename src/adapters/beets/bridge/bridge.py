#!/usr/bin/env python3
"""music-importer's stateless beets bridge.

Three verbs, one JSON document on stdout per invocation, no state between calls:

  propose <dir> [--search-id ID] [--search-artist A] [--search-album B]
      Run beets' matcher over a directory and emit candidates keyed by their
      (data_source, album_id) pair, with distance/penalty detail and the track
      mapping, plus any library incumbents the best candidate would duplicate.

  apply <dir> (--candidate SOURCE:ALBUM_ID | --as-is | --tags JSON)
        [--duplicate-action skip|replace|keep-both]
      Perform the import for a chosen outcome through a real ImportSession, so
      beets' full pipeline fires (tagging, move, plugin chain). A candidate is
      re-resolved deterministically via beets' search_ids direct ID lookup.

  validate
      Parse the user's config, check the library database and directory, and
      report the effective merged session view (the startup gate).

The user's own beets configuration is authoritative for everything
library-defining; the SESSION_OVERLAY below force-overrides the small
documented set of session keys (applied via config.set() BEFORE load_plugins(),
which is the ordering confuse requires for the overlay to win) so no invocation
can ever prompt, resume, or skip incrementally. The bootstrap also guarantees
the MusicBrainz candidate source plugin is loaded even when a plugin list
written for an older beets omits it. The JSON goes to a private duplicate of
stdout claimed before any beets work; fd 1 is repointed at stderr so nothing
beets or its plugins print can corrupt the contract channel. The beets version
is pinned in
requirements.txt and the runtime image; the JSON emitted here is frozen by the
contract-test fixtures under test/contract/.

Exit codes: 0 for every well-formed outcome (including business refusals, which
travel in the JSON as status=doomed/invalid); non-zero only for unexpected
crashes, which the TypeScript adapter surfaces as retryable infrastructure
errors with this process's stderr attached.
"""

import argparse
import json
import os
import sys

# The forced session keys (design D3): never interactive, never resuming, never
# incremental, single-threaded (one bridge invocation at a time drives beets).
SESSION_OVERLAY = {
    "import": {
        "quiet": False,  # interactivity is impossible: BridgeSession answers every question
        "timid": False,
        "resume": False,
        "incremental": False,
        "detail": False,
        "log": None,
        "search_ids": [],
    },
    "ui": {"color": False},
    "threaded": False,
    "verbose": 0,
}


# The contract channel: a private duplicate of real stdout, claimed by claim_stdout() before
# any beets work. Beets was designed as a CLI and prints freely (plugin loads, migrations,
# change diffs) — to fd 1 directly, not just sys.stdout, and so do subprocesses its plugins
# spawn (ffmpeg, fpcalc). Repointing fd 1 at stderr diverts all of it to the diagnostic
# stream, leaving this descriptor exclusively for the one JSON document per invocation.
_contract_channel = None


def claim_stdout():
    global _contract_channel
    _contract_channel = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr


def emit(payload):
    json.dump(payload, _contract_channel)
    _contract_channel.write("\n")
    _contract_channel.flush()


def deep_set(view, overlay):
    for key, value in overlay.items():
        if isinstance(value, dict):
            deep_set(view[key], value)
        else:
            view[key].set(value)


def bootstrap(config_path):
    """Load the user's config, force the session overlay, then load plugins.

    BEETSDIR points confuse at the config's directory (so sibling files like
    plugin token caches resolve as they do for the CLI); set_file makes the
    exact file authoritative even under a non-standard name; the overlay is
    applied before load_plugins() so plugins see the merged view.
    """
    config_path = os.path.abspath(config_path)
    if not os.path.isfile(config_path):
        raise BridgeRefusal("config-not-found", f"beets config not found: {config_path}")
    os.environ["BEETSDIR"] = os.path.dirname(config_path)

    from beets import config, plugins

    config.set_file(config_path)
    deep_set(config, SESSION_OVERLAY)
    # Guarantee the MusicBrainz candidate source: beets moved it from built-in to the
    # `musicbrainz` plugin, so a plugin list written for an older beets silently loads no
    # MB source at all. Sourcing candidates is session machinery (like non-interactivity),
    # so the bridge injects it into the effective list — never into the user's file. Other
    # source plugins were always opt-in and are honored as written.
    plugin_names = list(config["plugins"].as_str_seq())
    if "musicbrainz" not in plugin_names:
        config["plugins"].set([*plugin_names, "musicbrainz"])
    plugins.load_plugins()
    plugins.send("pluginload")
    return config


def open_library(config):
    from beets import ui

    lib = ui._open_library(config)
    from beets import plugins

    plugins.send("library_opened", lib=lib)
    return lib


class BridgeRefusal(Exception):
    """A permanent, well-formed refusal (doomed/invalid), never worth retrying."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def collect_items(directory):
    from beets import library

    if not os.path.isdir(directory):
        raise BridgeRefusal("directory-not-found", f"not a directory: {directory}")
    items = []
    for root, _dirs, files in os.walk(directory):
        for name in sorted(files):
            path = os.path.join(root, name)
            try:
                items.append(library.Item.from_path(os.fsencode(path)))
            except Exception:
                continue  # not an audio file beets can read
    if not items:
        raise BridgeRefusal("no-audio-files", f"no readable audio files under: {directory}")
    return items


def identifier_of(info):
    source, album_id = info.identifier
    return (source or "", str(album_id or ""))


def serialize_match(match):
    source, album_id = identifier_of(match.info)
    return {
        "data_source": source,
        "album_id": album_id,
        "artist": match.info.artist or "",
        "album": match.info.album or "",
        "distance": float(match.distance),
        "penalties": [
            {"name": name, "amount": amount} for name, amount in match.distance.items()
        ],
        "tracks": [
            {
                "path": os.fsdecode(item.path),
                "title": track.title or "",
                "index": track.index or 0,
            }
            for item, track in match.mapping.items()
        ],
    }


def serialize_album(album):
    try:
        path = os.fsdecode(album.path) if album.path else ""
    except Exception:
        path = ""
    return {
        "artist": album.albumartist or "",
        "album": album.album or "",
        "path": path,
    }


def find_incumbents(lib, artist, album):
    from beets.dbcore import query as dbquery

    matcher = dbquery.AndQuery(
        [dbquery.MatchQuery("albumartist", artist), dbquery.MatchQuery("album", album)]
    )
    return [serialize_album(existing) for existing in lib.albums(matcher)]


def run_propose(config, args):
    from beets import autotag

    items = collect_items(args.directory)
    lib = open_library(config)
    search_ids = [args.search_id] if args.search_id else []
    _artist, _album, proposal = autotag.tag_album(
        items,
        search_artist=args.search_artist,
        search_name=args.search_album,
        search_ids=search_ids,
    )
    candidates = sorted(proposal.candidates, key=lambda match: float(match.distance))
    duplicates = []
    if candidates:
        best = candidates[0].info
        duplicates = find_incumbents(lib, best.artist or "", best.album or "")
    return {
        "status": "proposal",
        "candidates": [serialize_match(match) for match in candidates],
        "duplicates": duplicates,
    }


def apply_manual_tags(task, tags):
    by_name = {os.path.basename(track["path"]): track for track in tags["tracks"]}
    for item in task.items:
        item.albumartist = tags["albumArtist"]
        item.album = tags["album"]
        if tags.get("year"):
            item.year = tags["year"]
        track = by_name.get(os.path.basename(os.fsdecode(item.path)))
        if track:
            item.title = track["title"]
            item.track = track["trackNumber"]
            if track.get("artist"):
                item.artist = track["artist"]
            if track.get("discNumber"):
                item.disc = track["discNumber"]


def make_session(importer_mod, lib, directory, choice):
    class BridgeSession(importer_mod.ImportSession):
        """Answers every question beets would otherwise ask a human."""

        def __init__(self):
            super().__init__(lib, None, [os.fsencode(directory)], None)
            self.found_duplicates = []
            self.skipped_duplicate = False
            self.candidate_missing = False

        def should_resume(self, path):
            return False

        def choose_item(self, task):
            return importer_mod.Action.ASIS

        def choose_match(self, task):
            mode = choice["mode"]
            if mode == "manual-tags":
                apply_manual_tags(task, choice["tags"])
            if mode in ("as-is", "manual-tags"):
                return importer_mod.Action.ASIS
            wanted = (choice["data_source"], choice["album_id"])
            for candidate in task.candidates:
                if identifier_of(candidate.info) == wanted:
                    return candidate
            self.candidate_missing = True
            return importer_mod.Action.SKIP

        def get_duplicate_action(self, task, found_duplicates):
            self.found_duplicates = [serialize_album(a) for a in found_duplicates]
            action = choice["duplicate_action"]
            if action == "replace":
                return importer_mod.DuplicateAction.REMOVE
            if action == "keep-both":
                return importer_mod.DuplicateAction.KEEP
            self.skipped_duplicate = True
            return importer_mod.DuplicateAction.SKIP

    return BridgeSession()


def run_apply(config, args):
    import beets.importer as importer_mod
    from beets.plugins import BeetsPlugin

    collect_items(args.directory)  # same refusals as propose for a bad directory
    lib = open_library(config)

    if args.candidate:
        source, _sep, album_id = args.candidate.partition(":")
        if not _sep or not source or not album_id:
            raise BridgeRefusal(
                "bad-candidate-ref", f"expected SOURCE:ALBUM_ID, got: {args.candidate}"
            )
        choice = {
            "mode": "candidate",
            "data_source": source,
            "album_id": album_id,
            "duplicate_action": args.duplicate_action,
        }
        config["import"]["search_ids"].set([album_id])
    elif args.tags:
        choice = {
            "mode": "manual-tags",
            "tags": json.loads(args.tags),
            "duplicate_action": args.duplicate_action,
        }
    else:
        choice = {"mode": "as-is", "duplicate_action": args.duplicate_action}

    if choice["mode"] in ("as-is", "manual-tags"):
        # No candidate lookup is needed (and no network should be touched): stub the task's
        # lookup so the pipeline flows straight to our ASIS choice.
        from beets import autotag

        def no_lookup(task, search_ids):
            task.cur_artist = None
            task.cur_album = None
            task.candidates = []
            task.rec = autotag.Recommendation.none

        importer_mod.ImportTask.lookup_candidates = no_lookup

    imported = []
    BeetsPlugin.listeners["album_imported"].append(
        lambda lib, album: imported.append(album)  # noqa: ARG005 - beets event signature
    )

    session = make_session(importer_mod, lib, args.directory, choice)
    failures = []
    try:
        session.run()
    except Exception as error:  # the plugin chain is network/CPU-dependent (design D7)
        if not imported:
            raise  # nothing moved: a plain retryable failure
        failures.append({"stage": "import-pipeline", "message": str(error)})

    if session.candidate_missing:
        raise BridgeRefusal(
            "candidate-not-found",
            f"candidate {args.candidate} no longer resolves by ID lookup",
        )
    if session.skipped_duplicate and not imported:
        return {"status": "skipped-duplicate", "incumbents": session.found_duplicates}
    if not imported:
        raise BridgeRefusal("nothing-imported", "beets imported no album for this directory")
    return {
        "status": "applied",
        "location": os.fsdecode(imported[-1].path) if imported[-1].path else "",
        "failures": failures,
    }


def run_validate(config):
    import beets

    try:
        db_path = config["library"].as_filename()
        directory = config["directory"].as_filename()
    except Exception as error:
        raise BridgeRefusal("config-invalid", f"unusable beets config: {error}")
    if not os.path.isdir(directory):
        raise BridgeRefusal("library-directory-missing", f"not a directory: {directory}")
    db_parent = os.path.dirname(db_path) or "."
    if not os.path.isdir(db_parent):
        raise BridgeRefusal("library-db-missing", f"database directory missing: {db_parent}")
    open_library(config)  # actually opens (and creates if absent) the database
    return {
        "status": "valid",
        "beets_version": beets.__version__,
        "library_database": db_path,
        "library_directory": directory,
        "plugins": list(config["plugins"].as_str_seq()),
        "overlay": SESSION_OVERLAY,
    }


def build_parser():
    parser = argparse.ArgumentParser(prog="beets-bridge")
    parser.add_argument("--config", required=True, help="path to the user's beets config.yaml")
    verbs = parser.add_subparsers(dest="verb", required=True)

    propose = verbs.add_parser("propose")
    propose.add_argument("directory")
    propose.add_argument("--search-id")
    propose.add_argument("--search-artist")
    propose.add_argument("--search-album")

    apply_parser = verbs.add_parser("apply")
    apply_parser.add_argument("directory")
    target = apply_parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--candidate")
    target.add_argument("--as-is", action="store_true")
    target.add_argument("--tags")
    apply_parser.add_argument(
        "--duplicate-action", choices=["skip", "replace", "keep-both"], default="skip"
    )

    verbs.add_parser("validate")
    return parser


def main(argv):
    claim_stdout()
    args = build_parser().parse_args(argv)
    try:
        config = bootstrap(args.config)
        if args.verb == "propose":
            emit(run_propose(config, args))
        elif args.verb == "apply":
            emit(run_apply(config, args))
        else:
            emit(run_validate(config))
    except BridgeRefusal as refusal:
        status = "invalid" if args.verb == "validate" else "doomed"
        emit({"status": status, "kind": refusal.kind, "reason": str(refusal)})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
