"""Build a to-scale site model JSON for one property.

    python build_site_model.py <config.json> <parcel.geojson> <units.json> <out.json>

Inputs: a property config (frame, buildings, zones, classification rules), the
parcel GeoJSON (one feature per parcel the facility sits on), and the Cubby
unit export. Output: site.json with every unit placed as a rectangle in the
local (u,v) meter frame. Unit positions are SCHEMATIC until an as-built plan
replaces them: drive-up units are laid along the exterior walls in unit-number
order, interior units along double-loaded corridors, parking stalls in rows
across the lot.

Config reference (see the *.config.json files beside this script):

  frame        lat0/lon0 origin, bearingDeg of the u axis (clockwise from north),
               mPerDegLon / mPerDegLat.
  image        detail imagery: file, bbox [W,S,E,N], px [w,h], attribution.
               imageWide: context imagery, bbox only.
  classify     ordered rules [{match: regex on the unit name, k: cc|ccdu|du|in|park|'',
               veh: 0|1, f: floor}]; the first rule that carries a property wins it.
               Units with no matching rule fall back to the Cubby fields
               (t = P parking / S enclosed, cc / du feature flags).
  buildings    id, letters (unit-name prefixes) or units (regex), kind, height,
               floors, roof, doorSide (sw|ne|both), note, inferred, deepRows
               (interior units laid long side in, for tightly packed buildings), autoFit
               (try both row directions and both unit turns, keep the fewest levels), and the
               footprint as either u/v ranges, a `rect` {E,N,L,W,bearing} from
               Microsoft Open Buildings (meters from the frame origin, bearing of
               the long side), or `px` corners on the detail image.
  zones        open lots: id, name, kind, letters or units regex, and the outline
               as px / ll / uv polygon or `parcels: [apn...]` (the parcel rings).
  gates        id, name, px or ll.
  pad          developed-area outline (px / ll); defaults to the parcels.
  planSizes    {"<unit>": [w, d]} in feet: sizes the as-built plans prove,
               applied over the unit list on every build - so a CubeSmart
               rent-roll refresh (which re-estimates vacant sizes) cannot undo
               them. Only for units whose listed size the plan disproves.
  runs         units TRACED from the as-built plans (Oct 14 2026): each run is an
               ordered line of units along a wall or corridor, placed exactly and
               ahead of the schematic layout (units in no run fall back to it).
                 building  building id (start is measured from its min-u/min-v
                           corner) - or zone id, or neither (start is frame u,v)
                 f         level (default 1)
                 at        [x, y] meters: the run's start point
                 dir       +u | -u | +v | -v: the direction the run advances
                 depth     +u | -u | +v | -v: the side the units extend toward
                           (their doors face the other way, onto the corridor)
                 units     ordered list: unit names, "1001-1040" ranges (same
                           prefix and digit count), or {"gap": meters} for a
                           stair, door or wall between units
                 width     optional fixed width (m) for every unit in the run
                           (stalls painted at a set pitch); default = the unit's
                           own width from its size
                 door      optional door side override (ne | sw | e | w)
                 numbering optional "inferred": the POSITIONS are from the plans
                           but the plan carries no unit numbers, so the numbers
                           were matched (e.g. by size order). Those units carry
                           tr: 2 instead of 1, and the screen says to confirm.
                 angle     optional stall angle in degrees between the run line
                           and each stall's long axis (default 90 = square on;
                           60 or 45 for angled parking, above 90 leans the
                           other way). The stall keeps its real width and depth,
                           is centered in its painted parallelogram, and carries
                           rot (degrees, counter-clockwise in u,v) in the output;
                           the pitch along the run is width / sin(angle).
               A traced unit carries tr: 1 in the output; layout.schematic is
               false once every unit is traced.
"""
import json
import math
import re
import sys
from datetime import date

FT = 0.3048
CORRIDOR = 1.6   # m, interior hallway
AISLE = 6.0      # m, drive aisle between stall rows


def natkey(n):
    m = re.match(r'([A-Z]*)(\d+)([A-Z]*)', n)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (n, 0, '')


def prefix(n):
    m = re.match(r'[A-Z]+', n)
    return m.group(0) if m else ''


def num(n):
    m = re.match(r'[A-Z]*(\d+)', n)
    return int(m.group(1)) if m else 0


def poly_contains(poly, p):
    x, y = p; c = False; j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi): c = not c
        j = i
    return c


class Builder:
    def __init__(self, cfg, parcel_fc, units):
        self.cfg = cfg; self.units = units; self.placed = []; self.flags = []
        fr = cfg['frame']; self.fr = fr
        b = math.radians(fr['bearingDeg']); self.su, self.cu = math.sin(b), math.cos(b)
        feats = parcel_fc['features']
        self.parcels = []
        for f in feats:
            g = f['geometry']; ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
            self.parcels.append({'apn': str((f.get('properties') or {}).get('apn', '')), 'uv': [self.ll_to_uv(*p[:2]) for p in ring]})
        img = cfg['image']; self.img = img
        self.W, self.S, self.E_, self.N_ = img['bbox']; self.pw, self.ph = img['px']

    # ---- frames ------------------------------------------------------------
    def ll_to_uv(self, lon, lat):
        fr = self.fr
        E = (lon - fr['lon0']) * fr['mPerDegLon']; N = (lat - fr['lat0']) * fr['mPerDegLat']
        return [round(E * self.su + N * self.cu, 2), round(-E * self.cu + N * self.su, 2)]

    def en_to_uv(self, E, N):
        return [round(E * self.su + N * self.cu, 2), round(-E * self.cu + N * self.su, 2)]

    def uv_to_ll(self, u, v):
        fr = self.fr
        E = u * self.su - v * self.cu; N = u * self.cu + v * self.su
        return [fr['lon0'] + E / fr['mPerDegLon'], fr['lat0'] + N / fr['mPerDegLat']]

    def px_to_uv(self, x, y):
        return self.ll_to_uv(self.W + x / self.pw * (self.E_ - self.W), self.N_ - y / self.ph * (self.N_ - self.S))

    def outline(self, spec):
        """Polygon in (u,v) from px / ll / uv / parcels."""
        if 'uv' in spec: return [list(p) for p in spec['uv']]
        if 'px' in spec: return [self.px_to_uv(*p) for p in spec['px']]
        if 'll' in spec: return [self.ll_to_uv(*p) for p in spec['ll']]
        if 'en' in spec: return [self.en_to_uv(*p) for p in spec['en']]
        return None

    def outlines(self, spec):
        if 'parcels' in spec:
            want = [str(a) for a in spec['parcels']]
            polys = [p['uv'] for p in self.parcels if p['apn'] in want]
            if len(polys) != len(want): self.flags.append(f"{spec.get('id')}: parcel outline not found for {want}")
            inset = float(spec.get('inset', 0))
            polys = [self.inset(p, inset) for p in polys] if inset else polys
        else:
            one = self.outline(spec)
            polys = [one] if one else []
        if 'uRange' in spec:
            a, b = spec['uRange']
            polys = [q for q in (self.clip_u(p, a, b) for p in polys) if len(q) >= 3]
        return polys

    @staticmethod
    def clip_u(poly, a, b):
        """Sutherland-Hodgman clip of a polygon to a <= u <= b."""
        def clip(pts, keep, at):
            out = []
            for i in range(len(pts)):
                p, q = pts[i], pts[(i + 1) % len(pts)]
                pin, qin = keep(p), keep(q)
                if pin: out.append(p)
                if pin != qin:
                    t = (at - p[0]) / (q[0] - p[0]); out.append([round(at, 2), round(p[1] + t * (q[1] - p[1]), 2)])
            return out
        pts = clip(poly, lambda p: p[0] >= a, a)
        return clip(pts, lambda p: p[0] <= b, b) if pts else []

    @staticmethod
    def inset(poly, d):
        """Shrink a polygon toward its centroid by about d meters (good enough for lot setbacks)."""
        cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
        out = []
        for x, y in poly:
            dx, dy = x - cx, y - cy; L = math.hypot(dx, dy) or 1
            k = max(0.0, 1 - d / L); out.append([round(cx + dx * k, 2), round(cy + dy * k, 2)])
        return out

    def rect_to_uv(self, r):
        """Microsoft footprint rectangle {E,N,L,W,bearing} -> axis-aligned u/v ranges in the frame."""
        cu, cv = self.en_to_uv(r['E'], r['N'])
        d = (r['bearing'] - self.fr['bearingDeg']) % 180
        along_u = d < 45 or d > 135
        lu, lv = (r['L'], r['W']) if along_u else (r['W'], r['L'])
        return [round(cu - lu / 2, 2), round(cu + lu / 2, 2)], [round(cv - lv / 2, 2), round(cv + lv / 2, 2)]

    # ---- units ------------------------------------------------------------
    def classify(self):
        for u in self.units:
            ps = self.cfg.get('planSizes', {}).get(u['n'])
            if ps:
                u['w'], u['d'] = ps[0], ps[1]
        rules = [(re.compile(r['match']), r) for r in self.cfg.get('classify', [])]
        for u in self.units:
            n = u['n']; k = None; veh = None; floor = None
            for rx, r in rules:
                if rx.match(n):
                    if k is None and 'k' in r: k = r['k']
                    if veh is None and 'veh' in r: veh = r['veh']
                    if floor is None and 'f' in r: floor = r['f']
            if k is None and u.get('k'): k = u['k']   # the export's own class, when no rule spoke
            if k is None:
                if u.get('t') == 'P': k = 'park'
                elif u.get('w', 0) <= 0: k = 'in'
                elif u.get('cc') and u.get('du'): k = 'ccdu'
                elif u.get('cc'): k = 'cc'
                elif u.get('du'): k = 'du'
                else: k = 'in'
            if veh is None:
                veh = 1 if (k == 'park' or (k in ('du', 'ccdu') and u.get('w', 0) >= 10 and u.get('d', 0) >= 25)) else 0
            u['k'] = k; u['veh'] = int(veh); u['fo'] = floor
            u['pw'] = int(u.get('pw') or 0)
            u['wm'] = round(u['w'] * FT, 2); u['dm'] = round(u['d'] * FT, 2)
        self.units.sort(key=lambda u: natkey(u['n']))

    def place(self, u, bid, floor, u0, v0, w, d, door):
        # Geometry: u,v = corner, wu = size along u, dv = size along v (meters).
        # Occupancy from Cubby: l leased, r rentable, why/note, dvac = days vacant.
        self.placed.append({'n': u['n'], 'w': u['w'], 'd': u['d'], 'k': u['k'], 'veh': u['veh'], 'pw': u['pw'],
                            'l': int(u.get('l') or 0), 'r': int(u.get('r') if u.get('r') is not None else 1),
                            'why': u.get('why') or '', 'note': u.get('note') or '', 'dvac': int(u.get('dv') or 0),
                            'b': bid, 'f': floor, 'u': round(u0, 2), 'v': round(v0, 2),
                            'wu': round(w, 2), 'dv': round(d, 2), 'door': door})

    # ---- traced runs (as-built plans) ---------------------------------------
    VEC = {'+u': (1, 0), '-u': (-1, 0), '+v': (0, 1), '-v': (0, -1)}
    DOOR = {'+v': 'ne', '-v': 'sw', '+u': 'e', '-u': 'w'}   # the way a door FACES
    OPP = {'+u': '-u', '-u': '+u', '+v': '-v', '-v': '+v'}

    def expand(self, names):
        """Run entries -> unit names and gaps, ranges spelled out."""
        out = []
        for e in names:
            if isinstance(e, dict):
                out.append(e); continue
            # A real unit name wins over a range: combined units are named
            # "1003-1004" at some sites.
            if str(e) in self.by_name:
                out.append(str(e)); continue
            m = re.fullmatch(r'([A-Z]*)(\d+)([A-Z]*)-(?:[A-Z]*)(\d+)([A-Z]*)', str(e))
            if m:
                pre, a, suf, b = m.group(1), m.group(2), m.group(3), m.group(4)
                step = 1 if int(b) >= int(a) else -1
                for k in range(int(a), int(b) + step, step):
                    out.append(f"{pre}{str(k).zfill(len(a))}{suf}")
            else:
                out.append(str(e))
        return out

    def place_run(self, r, index, traced):
        bid = r.get('building') or r.get('zone') or ''
        bd = next((b for b in self.cfg['buildings'] if b['id'] == bid), None)
        x0, y0 = r.get('at', [0, 0])
        ou, ov = (bd['u'][0] + x0, bd['v'][0] + y0) if bd else (x0, y0)
        try:
            du_, dv_ = self.VEC[r['dir']]; pu, pv = self.VEC[r['depth']]
        except KeyError:
            self.flags.append(f"run {index + 1} ({bid}): dir/depth must be +u, -u, +v or -v"); return
        if du_ * pu + dv_ * pv != 0:
            self.flags.append(f"run {index + 1} ({bid}): dir and depth must be at right angles"); return
        door = r.get('door') or self.DOOR[self.OPP[r['depth']]]
        floor = int(r.get('f', 1)); s = 0.0
        ang = float(r.get('angle', 90) or 90)
        th = math.radians(ang)
        ax, ay = math.cos(th) * du_ + math.sin(th) * pu, math.cos(th) * dv_ + math.sin(th) * pv   # stall axis
        rot = round(math.degrees(math.atan2(pu * ay - pv * ax, pu * ax + pv * ay)), 1)
        trv = 2 if r.get('numbering') == 'inferred' else 1
        for e in self.expand(r.get('units', [])):
            if isinstance(e, dict):
                s += float(e.get('gap', 0)); continue
            x = self.by_name.get(e)
            if x is None:
                self.flags.append(f"run {index + 1} ({bid}): {e} is on the plan but not in the unit list")
                s += float(r.get('width') or 0); continue
            if e in traced:
                self.flags.append(f"run {index + 1} ({bid}): {e} is in two runs"); continue
            w = float(r.get('width') or x['wm'] or 0.35); d = x['dm'] or 0.35
            if abs(ang - 90) > 0.01:
                # Angled: the stall's own w x d, centered in its parallelogram
                # (pitch along the run, depth along the stall axis), turned by rot.
                pitch = w / max(0.2, math.sin(th))
                cx = ou + du_ * (s + pitch / 2) + ax * d / 2
                cy = ov + dv_ * (s + pitch / 2) + ay * d / 2
                wu, dv = (w, d) if du_ else (d, w)
                self.place(x, bid, floor, cx - wu / 2, cy - dv / 2, wu, dv, door)
                self.placed[-1]['tr'] = trv; self.placed[-1]['rot'] = rot
                traced.add(e); s += pitch
                continue
            a = (ou + du_ * s, ov + dv_ * s)
            b = (ou + du_ * (s + w) + pu * d, ov + dv_ * (s + w) + pv * d)
            wu, dv = abs(b[0] - a[0]), abs(b[1] - a[1])
            self.place(x, bid, floor, min(a[0], b[0]), min(a[1], b[1]), wu, dv, door)
            self.placed[-1]['tr'] = trv
            traced.add(e); s += w

    def select(self, spec):
        if 'units' in spec:
            rx = re.compile(spec['units']); return [x for x in self.units if rx.match(x['n'])]
        letters = spec.get('letters', [])
        return [x for x in self.units if prefix(x['n']) in letters]

    # ---- buildings --------------------------------------------------------
    def take_row(self, items, i, ua, ub):
        row = []; uu = ua; rowd = 0.0
        while i < len(items):
            x = items[i]; w, d = x['wm'], x['dm']
            if w <= 0.3: w, d = 0.35, 0.35          # mailbox / unsized cell
            if uu + w > ub + 0.01: break
            row.append((x, uu, w, d)); uu += w; rowd = max(rowd, d); i += 1
        return row, rowd, i

    def fill_rows(self, bd, items, i, floor, ua, ub, iv0, iv1):
        """Double-loaded corridors: row A (doors toward +v), corridor, row B (doors toward -v), back to back."""
        v = iv0
        while i < len(items):
            rowA, dA, iA = self.take_row(items, i, ua, ub)
            if not rowA:
                self.flags.append(f"{bd['id']}: unit {items[i]['n']} is wider than the building"); i += 1; continue
            rowB, dB, iB = self.take_row(items, iA, ua, ub)
            need = dA + self.corridor + dB
            if v + need > iv1 + 0.01:
                if v > iv0 + 0.01: return i            # next floor retries this row
                if rowB and v + dA + self.corridor <= iv1 + 0.01:   # only row A fits here
                    rowB, dB, iB = [], 0.0, iA; need = dA + self.corridor
                else:
                    return i
            for x, uu, w, d in rowA: self.place(x, bd['id'], floor, uu, v, w, d, 'ne')
            for x, uu, w, d in rowB: self.place(x, bd['id'], floor, uu, v + dA + self.corridor + (dB - d), w, d, 'sw')
            v += need; i = iB
        return i

    def fill(self, bd, items, i, floor, ua, ub, iv0, iv1):
        """fill_rows, or with rowsAcross the same hallways turned 90 degrees (rows run
        across the building); drive-up strips on the long walls are not affected."""
        if not bd.get('rowsAcross'):
            return self.fill_rows(bd, items, i, floor, ua, ub, iv0, iv1)
        start = len(self.placed)
        j = self.fill_rows(bd, items, i, floor, iv0, iv1, ua, ub)
        for p in self.placed[start:]:
            p['u'], p['v'], p['wu'], p['dv'] = p['v'], p['u'], p['dv'], p['wu']
            p['door'] = {'sw': 'w', 'ne': 'e'}.get(p['door'], p['door'])
        return j

    def layout_building(self, bd, items):
        if not bd.get('autoFit'):
            return self._layout_oriented(bd, items)
        # autoFit: try rows along / across the building, units as listed / turned long
        # side in, and keep the layout that needs the fewest levels (then the fewest flags)
        trials = []
        for across in (False, True):
            for deep in (False, True):
                start, nflags = len(self.placed), len(self.flags)
                dims0 = [(x['wm'], x['dm']) for x in items]
                trial = {**bd, 'deepRows': deep, 'rowsAcross': across}
                self._layout_oriented(trial, items)
                trials.append((trial.get('floorsUsed', 99), len(self.flags) - nflags, across, deep))
                del self.placed[start:]; del self.flags[nflags:]
                for x, (w, d) in zip(items, dims0): x['wm'], x['dm'] = w, d; x.pop('full', None)
        _, _, across, deep = min(trials)
        bd['deepRows'] = deep; bd['rowsAcross'] = across
        self._layout_oriented(bd, items)

    def _layout_oriented(self, bd, items):
        self.corridor = float(bd.get('corridor', CORRIDOR))
        if (bd['v'][1] - bd['v'][0]) > (bd['u'][1] - bd['u'][0]) * 1.15:
            start = len(self.placed)
            self._layout_building({**bd, 'u': bd['v'], 'v': bd['u'], 'doorSide': {'sw': 'w', 'ne': 'e'}.get(bd.get('doorSide', 'both'), 'both')}, items, bd)
            for p in self.placed[start:]:
                p['u'], p['v'], p['wu'], p['dv'] = p['v'], p['u'], p['dv'], p['wu']
                p['door'] = {'sw': 'w', 'ne': 'e', 'w': 'sw', 'e': 'ne'}.get(p['door'], p['door'])
            return
        self._layout_building(bd, items, bd)

    def _layout_building(self, bd, items, real):
        u0, u1 = bd['u']; v0, v1 = bd['v']; Wd = v1 - v0
        du = [x for x in items if x['k'] in ('du', 'ccdu')]
        inner = [x for x in items if x['k'] not in ('du', 'ccdu')]
        if real.get('deepRows'):
            # Interior units turned long side in: deeper rows mean fewer hallways, which is
            # what a tightly packed multi-story building needs (the CubeSmart sites, ~78% net)
            for x in inner:
                if x['wm'] > x['dm']: x['wm'], x['dm'] = x['dm'], x['wm']
        side = {'w': 'sw', 'e': 'ne'}.get(bd.get('doorSide', 'both'), bd.get('doorSide', 'both'))
        primary = 'sw' if side in ('sw', 'both') else 'ne'
        secondary = 'ne' if primary == 'sw' else 'sw'
        for x in du: x['full'] = x['dm'] >= Wd * 0.8
        full = [x for x in du if x['full']]; part = [x for x in du if not x['full']]
        # Full-depth garages span the building; they take the first stretch of its length.
        uu = u0; floor = 1
        for x in full:
            if uu + x['wm'] > u1 + 0.01:
                self.flags.append(f"{bd['id']}: {len(full) - full.index(x)} full-depth units do not fit the length ({x['n']}..) - continued on the next level"); floor += 1; uu = u0
            self.place(x, bd['id'], floor, uu, v0, x['wm'], Wd, 'both'); uu += x['wm']
        full_until = uu if floor == 1 else u1
        floors_used = floor
        # Part-depth drive-ups along the long walls, deepest first on the primary side.
        part.sort(key=lambda x: (-x['dm'], natkey(x['n'])))
        strip = {'sw': 0.0, 'ne': 0.0}; floor = 1
        walls = [primary, secondary] if side == 'both' else [primary]
        wi = 0; uu = full_until
        for x in part:
            if uu + x['wm'] > u1 + 0.01:
                wi += 1
                if wi >= len(walls):
                    wi = 0; floor += 1; uu = u0
                    self.flags.append(f"{bd['id']}: drive-up units overflow to level {floor} ({x['n']}..) - the building is longer or has more drive-up walls than modeled")
                else:
                    uu = u0
            wall = walls[wi]
            dm = min(x['dm'], Wd / 2) if side == 'both' else min(x['dm'], Wd)
            if floor == 1: strip[wall] = max(strip[wall], dm)
            vv = v0 if wall == 'sw' else v1 - dm
            self.place(x, bd['id'], floor, uu, vv, x['wm'], dm, wall); uu += x['wm']
        floors_used = max(floors_used, floor)
        if inner:
            groups = {}
            for x in inner: groups.setdefault(x.get('fo') or 1, []).append(x)
            next_floor = 1
            for f0 in sorted(groups):
                grp = groups[f0]
                # Same-depth units share a row so a row is never as deep as its one deepest unit.
                grp.sort(key=lambda x: (-x['dm'], natkey(x['n'])))
                f = max(f0, next_floor)
                if f == 1:
                    i = self.fill(bd, grp, 0, 1, full_until, u1, v0 + strip['sw'] if floors_used == 1 else v0, v1 - strip['ne'] if floors_used == 1 else v1)
                else:
                    i = self.fill(bd, grp, 0, f, u0, u1, v0, v1)
                while i < len(grp):
                    f += 1
                    j = self.fill(bd, grp, i, f, u0, u1, v0, v1)
                    if j == i:
                        self.flags.append(f"{bd['id']}: unit {grp[i]['n']} does not fit the building width"); i += 1
                    else: i = j
                next_floor = f + 1
                floors_used = max(floors_used, f)
        if floors_used > real.get('floors', 1):
            self.flags.append(f"{bd['id']}: schematic needs {floors_used} levels for the unit area (configured {real.get('floors', 1)}) - confirm the real floor count")
            real['floors'] = floors_used
        real['floorsUsed'] = floors_used

    # ---- lots -------------------------------------------------------------
    def layout_lot(self, zone, items):
        i = 0
        for poly in zone['polys']:
            us = [p[0] for p in poly]; vs = [p[1] for p in poly]
            u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
            v = v0 + 0.5; row_i = 0
            while i < len(items) and v < v1:
                rowd = max(x['dm'] for x in items[i:i + 40]) or 9.0
                uu = u0 + 0.5; placed_any = False
                while i < len(items) and uu < u1:
                    x = items[i]; w = x['wm'] or 3.6; d = x['dm'] or 9.0
                    c = (uu + w / 2, v + rowd / 2)
                    if poly_contains(poly, c):
                        self.place(x, zone['id'], 1, uu, v, w, d, 'sw' if row_i % 2 else 'ne'); i += 1; placed_any = True
                    uu += w
                v += rowd + (AISLE if row_i % 2 else 0.6); row_i += 1
                if not placed_any and v > v1: break
            if i >= len(items): break
        if i < len(items):
            poly = zone['polys'][-1]; us = [p[0] for p in poly]; vs = [p[1] for p in poly]
            u0, u1, v = min(us), max(us), max(vs) + AISLE
            self.flags.append(f"{zone['id']}: {len(items) - i} stalls placed in an overflow row outside the drawn lot ({items[i]['n']}..) - lot outline needs the as-built")
            uu = u0 + 0.5; rowd = max(x['dm'] for x in items[i:]) or 9.0
            while i < len(items):
                x = items[i]; w = x['wm'] or 3.6; d = x['dm'] or 9.0
                if uu + w > u1: uu = u0 + 0.5; v += rowd + AISLE
                self.place(x, zone['id'], 1, uu, v, w, d, 'ne'); i += 1; uu += w

    # ---- run --------------------------------------------------------------
    def build(self):
        cfg = self.cfg
        self.classify()
        for bd in cfg['buildings']:
            if 'rect' in bd: bd['u'], bd['v'] = self.rect_to_uv(bd['rect'])
            elif 'px' in bd:
                pts = [self.px_to_uv(*p) for p in bd['px']]
                bd['u'] = [round(min(p[0] for p in pts), 2), round(max(p[0] for p in pts), 2)]
                bd['v'] = [round(min(p[1] for p in pts), 2), round(max(p[1] for p in pts), 2)]
            bd['ll'] = [self.uv_to_ll(bd['u'][a], bd['v'][c]) for a, c in ((0, 0), (1, 0), (1, 1), (0, 1))]
        for z in cfg.get('zones', []):
            z['polys'] = self.outlines(z)
            z['uv'] = z['polys'][0] if z['polys'] else []
        pad = self.outlines(cfg['pad']) if cfg.get('pad') else [p['uv'] for p in self.parcels]
        for g in cfg.get('gates', []): g['uv'] = self.px_to_uv(*g['px']) if 'px' in g else self.outline(g)[0]
        img_uv = [self.px_to_uv(0, 0), self.px_to_uv(self.pw, 0), self.px_to_uv(self.pw, self.ph), self.px_to_uv(0, self.ph)]
        wide = cfg.get('imageWide')
        if wide:
            w0, s0, e0, n0 = wide['bbox']
            wide['uv'] = [self.ll_to_uv(w0, n0), self.ll_to_uv(e0, n0), self.ll_to_uv(e0, s0), self.ll_to_uv(w0, s0)]

        # Traced runs first: the plan wins; the rest is laid out schematically.
        self.by_name = {u['n']: u for u in self.units}
        taken = set()
        for i, r in enumerate(cfg.get('runs', [])):
            self.place_run(r, i, taken)
        for bd in cfg['buildings']:
            items = [x for x in self.select(bd) if x['n'] not in taken]
            taken.update(x['n'] for x in items)
            self.layout_building(bd, items)
        for z in cfg.get('zones', []):
            items = [x for x in self.select(z) if x['n'] not in taken]
            taken.update(x['n'] for x in items)
            if z['polys']: self.layout_lot(z, items)
            else: self.flags.append(f"{z['id']}: no outline, {len(items)} units not placed")
        missing = sorted(set(u['n'] for u in self.units) - set(p['n'] for p in self.placed), key=natkey)
        if missing: self.flags.append(f"{len(missing)} units not placed: {', '.join(missing[:12])}")

        north = [round(self.cu, 4), round(self.su, 4)]  # true north as a unit vector in (u,v)
        prop_keys = ('id', 'name', 'address', 'apn', 'acreage', 'opened', 'cubbyFacilityId', 'county', 'parcelSource', 'operator', 'unitSource')
        site = {
            'property': {k: cfg[k] for k in prop_keys if k in cfg},
            'frame': {**self.fr, 'north': north},
            'image': {**{k: self.img[k] for k in ('bbox', 'px', 'attribution')}, 'uv': img_uv},
            'imageWide': ({'bbox': wide['bbox'], 'uv': wide['uv']} if wide else None),
            'parcel': self.parcels[0]['uv'] if self.parcels else [],
            'parcels': [{'apn': p['apn'], 'uv': p['uv']} for p in self.parcels],
            'pad': pad[0] if pad else [], 'pads': pad,
            'gates': [{k: g[k] for k in ('id', 'name', 'uv')} for g in cfg.get('gates', [])],
            'buildings': [{k: bd.get(k) for k in ('id', 'letters', 'name', 'kind', 'u', 'v', 'height', 'floors', 'roof', 'inferred', 'note', 'll')} for bd in cfg['buildings']],
            'zones': [{'id': z['id'], 'name': z['name'], 'kind': z.get('kind', 'lot'), 'uv': z['uv'], 'polys': z['polys']} for z in cfg.get('zones', [])],
            'units': self.placed,
            'layout': {'schematic': any(not p.get('tr') for p in self.placed),
                       'traced': sum(1 for p in self.placed if p.get('tr') == 1),
                       'numbersInferred': sum(1 for p in self.placed if p.get('tr') == 2),
                       'flags': self.flags, 'generated': date.today().strftime('%b %d, %Y')},
            'sources': cfg.get('sources', []),
        }
        return site


def main():
    cfg = json.load(open(sys.argv[1]))
    parcel = json.load(open(sys.argv[2]))
    units = json.load(open(sys.argv[3]))
    out_path = sys.argv[4]
    b = Builder(cfg, parcel, units)
    site = b.build()
    json.dump(site, open(out_path, 'w'), separators=(',', ':'))
    print('units placed', len(site['units']), 'of', len(units))
    for f in site['layout']['flags']: print('FLAG', f)
    for bd in site['buildings']:
        n = sum(1 for p in site['units'] if p['b'] == bd['id'])
        area = sum(p['w'] * p['d'] for p in site['units'] if p['b'] == bd['id'])
        print(bd['id'], 'units', n, 'rentable sqft', round(area), 'footprint sqft', round((bd['u'][1] - bd['u'][0]) * (bd['v'][1] - bd['v'][0]) * 10.764), 'floors', bd['floors'])
    for z in site['zones']:
        n = sum(1 for p in site['units'] if p['b'] == z['id'])
        print(z['id'], 'stalls', n)
    print('parcels', [len(p['uv']) for p in site['parcels']], 'north', site['frame']['north'])


if __name__ == '__main__':
    main()
