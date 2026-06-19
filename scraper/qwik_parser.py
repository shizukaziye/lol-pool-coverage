"""
Parser for lolalytics's Qwik-serialized q-data.json blobs.

Top-level shape: {"_objs": [...]} where each entry is a string, number, list,
or dict. Cross-references are encoded as base-36 indices into _objs.

Two entry points:
  * parse_tierlist(blob) -> dict with `meta`, `tierlist`
  * parse_build_matchups(blob, lane) -> list of (riot_id, wr, d1, d2, ?, games)

For the build page, the matchup list is nested deep in _objs. Heuristic: find
all lists of length 50..200 where every entry decodes (after deref) to a list
of length 6 whose [0] is a string of digits (riot_id) and whose remaining
entries are numbers. There are typically 5 such lists per build page — one per
lane. We pick the matchup list whose first few entries' riot_ids overlap the
known-champions set for the given lane (caller supplies that set).
"""

from __future__ import annotations

from typing import Any, Callable, Optional


def _b36(s: Any) -> Optional[int]:
    if not isinstance(s, str):
        return None
    try:
        return int(s, 36)
    except ValueError:
        return None


def make_deref(objs: list) -> Callable[[Any], Any]:
    def deref(v: Any) -> Any:
        i = _b36(v)
        if i is not None and 0 <= i < len(objs):
            return objs[i]
        return v

    return deref


def _is_meta_dict(d: dict) -> bool:
    """Heuristic for the meta dict that carries champPath / champId / champions."""
    keys = set(d.keys())
    return {"champPath", "champId", "champions"}.issubset(keys) or "champPath" in keys


def _find_meta(objs: list, deref: Callable[[Any], Any]) -> Optional[dict]:
    for entry in objs:
        if isinstance(entry, dict) and _is_meta_dict(entry):
            return entry
    return None


def _resolve_str(v: Any, deref: Callable[[Any], Any]) -> Optional[str]:
    cur = v
    for _ in range(3):
        r = deref(cur)
        if isinstance(r, str):
            return r
        if r is cur:
            return None
        cur = r
    return None


def _resolve_list(v: Any, deref: Callable[[Any], Any]) -> Optional[list]:
    cur = v
    for _ in range(3):
        r = deref(cur)
        if isinstance(r, list):
            return r
        if r is cur:
            return None
        cur = r
    return None


def _resolve_num(v: Any, deref: Callable[[Any], Any]) -> Optional[float]:
    cur = v
    for _ in range(3):
        r = deref(cur)
        if isinstance(r, (int, float)) and not isinstance(r, bool):
            return float(r)
        if isinstance(r, str):
            # Numeric strings happen.
            try:
                return float(r)
            except ValueError:
                return None
        if r is cur:
            return None
        cur = r
    return None


def _resolve_rid(v: Any, deref: Callable[[Any], Any]) -> Optional[str]:
    """Resolve a champion riot id, normalized to a string of digits.

    Live lolalytics stores riot ids in matchup tuples as ints (e.g. 266) but
    the tierlist meta and the synthetic test fixtures use digit-strings. Accept
    either and always return the digit-string form.
    """
    cur = v
    for _ in range(3):
        r = deref(cur)
        if isinstance(r, bool):
            return None
        if isinstance(r, int):
            return str(r)
        if isinstance(r, float):
            return str(int(r)) if r.is_integer() else None
        if isinstance(r, str):
            return r if r.isdigit() else None
        if r is cur:
            return None
        cur = r
    return None


def _resolve_dict(v: Any, deref: Callable[[Any], Any]) -> Optional[dict]:
    cur = v
    for _ in range(3):
        r = deref(cur)
        if isinstance(r, dict):
            return r
        if r is cur:
            return None
        cur = r
    return None


def _looks_like_champ_entry(entry: list, deref) -> bool:
    """A 6-tuple [riot_id, wr, d1, d2, _, games] where riot_id resolves to a
    champion id (int on live data, digit-string in fixtures)."""
    if not isinstance(entry, list) or len(entry) < 6:
        return False
    rid = _resolve_rid(entry[0], deref)
    if rid is None:
        return False
    games = _resolve_num(entry[5], deref)
    if games is None or games < 0:
        return False
    return True


def _looks_like_tierlist_dict(d: dict) -> bool:
    """The tierlist entries have pr/wr/rank/games/lane (or refs to them)."""
    keys = set(d.keys())
    return {"pr", "wr"}.issubset(keys) and ("games" in keys or "rank" in keys)


# ---------- Public API ----------


def parse_tierlist(blob: dict) -> dict:
    """
    Returns:
        {
          "meta": <meta dict, deref'd shallow>,
          "champ_path": [slug, ...],     # in canonical champion order
          "champ_ids":  [riot_id, ...],  # same order, strings
          "champ_names":[name, ...],     # same order
          "tierlist": [ {pr, wr, rank, games, lane}, ... ]  # same length & order as champ_path
        }
    """
    objs = blob["_objs"]
    deref = make_deref(objs)

    meta = _find_meta(objs, deref)
    if meta is None:
        raise ValueError("tierlist: meta dict (champPath/champId/champions) not found")

    # The meta arrays come in two shapes:
    #   * list form (synthetic fixtures): champPath/champId/champions are parallel
    #     lists in canonical champion order.
    #   * dict form (live lolalytics): champPath is {seq_str: slug_ref}; champId is
    #     {slug: riot_id_ref}; champions is {slug: name_ref} (keyed by slug, not
    #     parallel). We materialize parallel arrays in champPath's sequence order.
    champ_path_list = _resolve_list(meta.get("champPath"), deref)
    if champ_path_list is not None:
        champ_id_list = _resolve_list(meta.get("champId"), deref) or []
        champions_list = _resolve_list(meta.get("champions"), deref) or []
        champ_path_s = [_resolve_str(x, deref) or "" for x in champ_path_list]
        champ_ids_s = [_resolve_rid(x, deref) or "" for x in champ_id_list]
        champ_names_s = [_resolve_str(x, deref) or "" for x in champions_list]
    else:
        path_d = _resolve_dict(meta.get("champPath"), deref) or {}
        id_d = _resolve_dict(meta.get("champId"), deref) or {}
        name_d = _resolve_dict(meta.get("champions"), deref) or {}

        def _seq_key(k: str):
            try:
                return (0, int(k))
            except ValueError:
                return (1, k)

        ordered_slugs = [_resolve_str(path_d[k], deref) or "" for k in sorted(path_d, key=_seq_key)]
        slug_to_rid = {slug: _resolve_rid(v, deref) or "" for slug, v in id_d.items()}
        slug_to_name = {slug: _resolve_str(v, deref) or "" for slug, v in name_d.items()}
        champ_path_s = ordered_slugs
        champ_ids_s = [slug_to_rid.get(slug, "") for slug in ordered_slugs]
        champ_names_s = [slug_to_name.get(slug, "") for slug in ordered_slugs]

    n = len(champ_path_s)

    # Find all dicts that look like tierlist entries.
    tier_dicts = [d for d in objs if isinstance(d, dict) and _looks_like_tierlist_dict(d)]

    # Lolalytics returns one entry per champion, in champ_path order. Take the
    # first N where N matches len(champ_path); if there are exactly n+something
    # extras (e.g. role buckets), we still want the first n that align.
    if len(tier_dicts) < n:
        raise ValueError(
            f"tierlist: found {len(tier_dicts)} candidate entries, expected ≥ {n}"
        )

    tierlist = []
    for d in tier_dicts[:n]:
        tierlist.append(
            {
                "pr": _resolve_num(d.get("pr"), deref),
                "wr": _resolve_num(d.get("wr"), deref),
                "rank": _resolve_num(d.get("rank"), deref),
                "tier": _resolve_num(d.get("tier"), deref),
                "games": _resolve_num(d.get("games"), deref),
                "lane": _resolve_str(d.get("lane"), deref),
            }
        )

    return {
        "meta": meta,
        "champ_path": champ_path_s,
        "champ_ids": champ_ids_s,
        "champ_names": champ_names_s,
        "tierlist": tierlist,
    }


ROLE_KEYS = ("top", "jungle", "middle", "bottom", "support")


def _parse_matchup_list(lst: list, deref: Callable[[Any], Any]) -> list[dict]:
    """Turn one raw matchup list (list of 6-tuples) into matchup dicts."""
    out = []
    for sub in lst:
        sub_l = _resolve_list(sub, deref)
        if sub_l is None or not _looks_like_champ_entry(sub_l, deref):
            continue
        rid = _resolve_rid(sub_l[0], deref)
        wr = _resolve_num(sub_l[1], deref)
        d1 = _resolve_num(sub_l[2], deref)
        d2 = _resolve_num(sub_l[3], deref)
        games = _resolve_num(sub_l[5], deref)
        if rid is None or games is None:
            continue
        out.append({"riot_id": rid, "wr": wr, "d1": d1, "d2": d2, "games": int(games)})
    return out


def _find_role_container(objs: list, deref: Callable[[Any], Any]) -> Optional[dict]:
    """Find the dict that maps {top,jungle,middle,bottom,support} -> matchup lists.

    lolalytics nests the subject champ's five matchup tables (one per ENEMY role)
    in a single role-keyed dict. We identify it by the five literal lane keys
    whose values deref to champ-entry lists.
    """
    for d in objs:
        if not isinstance(d, dict) or not all(k in d for k in ROLE_KEYS):
            continue
        ok = 0
        for role in ROLE_KEYS:
            lst = _resolve_list(d.get(role), deref)
            if lst and 40 <= len(lst) <= 300:
                first = _resolve_list(lst[0], deref)
                if first is not None and _looks_like_champ_entry(first, deref):
                    ok += 1
        if ok >= 3:
            return d
    return None


def parse_build_matchups_by_role(blob: dict) -> dict[str, list[dict]]:
    """Return the subject champ's matchups against enemies in ALL five roles.

    Returns { "top": [{riot_id, wr, d1, d2, games}, ...], "jungle": [...], ... }.
    The subject's own lane key holds the same-lane matchups; the other four are
    cross-role (e.g. a top laner's win-rate delta vs each enemy jungler). Roles
    with no parseable list are omitted.
    """
    objs = blob["_objs"]
    deref = make_deref(objs)
    container = _find_role_container(objs, deref)
    if container is None:
        return {}
    out: dict[str, list[dict]] = {}
    for role in ROLE_KEYS:
        lst = _resolve_list(container.get(role), deref)
        if lst is None:
            continue
        parsed = _parse_matchup_list(lst, deref)
        if parsed:
            out[role] = parsed
    return out


def parse_build_matchups(blob: dict, lane_riot_ids: set[str]) -> list[dict]:
    """
    Find the matchup list whose entries' riot_ids best overlap the given
    lane_riot_ids set, and return it as a list of dicts:
        [{"riot_id": "266", "wr": 50.1, "d1": ..., "d2": -0.45, "games": 1074}, ...]

    lane_riot_ids = the set of riot_ids that show up in that lane's tierlist (i.e.
    candidate opponents). This disambiguates which of the ~5 matchup lists is the
    one for the subject's lane.
    """
    objs = blob["_objs"]
    deref = make_deref(objs)

    candidate_lists: list[list] = []
    for entry in objs:
        if not isinstance(entry, list):
            continue
        if not (40 <= len(entry) <= 250):
            continue
        # Quick sniff: first 3 entries must look like champ entries.
        sniff_ok = True
        for sub in entry[:3]:
            sub_l = _resolve_list(sub, deref)
            if sub_l is None or not _looks_like_champ_entry(sub_l, deref):
                sniff_ok = False
                break
        if sniff_ok:
            candidate_lists.append(entry)

    if not candidate_lists:
        return []

    # Score each list by overlap of its first 20 riot_ids with lane_riot_ids.
    def score_list(lst: list) -> int:
        score = 0
        for sub in lst[:20]:
            sub_l = _resolve_list(sub, deref)
            if sub_l is None:
                continue
            rid = _resolve_rid(sub_l[0], deref)
            if rid in lane_riot_ids:
                score += 1
        return score

    best = max(candidate_lists, key=score_list)

    out = []
    for sub in best:
        sub_l = _resolve_list(sub, deref)
        if sub_l is None or not _looks_like_champ_entry(sub_l, deref):
            continue
        rid = _resolve_rid(sub_l[0], deref)
        wr = _resolve_num(sub_l[1], deref)
        d1 = _resolve_num(sub_l[2], deref)
        d2 = _resolve_num(sub_l[3], deref)
        games = _resolve_num(sub_l[5], deref)
        if rid is None or games is None:
            continue
        out.append(
            {
                "riot_id": rid,
                "wr": wr,
                "d1": d1,
                "d2": d2,
                "games": int(games),
            }
        )
    return out
