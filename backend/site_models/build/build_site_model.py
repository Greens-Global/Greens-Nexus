"""Build a to-scale site model JSON for one property.

Inputs: a property config (frame, buildings, zones in local meters or image
pixels), the parcel GeoJSON, and the Cubby unit export. Output: site.json with
every unit placed as a rectangle in the local (u,v) frame. Unit positions are
SCHEMATIC until an as-built plan replaces them: drive-up units are laid along
the exterior walls in unit-number order, interior units along double-loaded
corridors, parking stalls in rows across the lot.
"""
import json, math, re, sys

FT = 0.3048
CORRIDOR = 1.6   # m, interior hallway
AISLE = 6.0      # m, RV drive aisle

cfg = json.load(open(sys.argv[1]))
parcel = json.load(open(sys.argv[2]))['features'][0]['geometry']
units = json.load(open(sys.argv[3]))
out_path = sys.argv[4]

fr = cfg['frame']
b = math.radians(fr['bearingDeg'])
su, cu = math.sin(b), math.cos(b)

def ll_to_uv(lon, lat):
    E = (lon - fr['lon0']) * fr['mPerDegLon']
    N = (lat - fr['lat0']) * fr['mPerDegLat']
    return [round(E * su + N * cu, 2), round(-E * cu + N * su, 2)]  # u along bearing (SE), v toward NE

def uv_to_ll(u, v):
    E = u * su - v * cu
    N = u * cu + v * su
    return [fr['lon0'] + E / fr['mPerDegLon'], fr['lat0'] + N / fr['mPerDegLat']]

img = cfg['image']
W, S, E_, N_ = img['bbox']; pw, ph = img['px']
def px_to_uv(x, y):
    return ll_to_uv(W + x / pw * (E_ - W), N_ - y / ph * (N_ - S))

# ---- unit classification (feature strings are not in the slim export) ----
def num(n):
    m = re.match(r'[A-Z]+(\d+)', n); return int(m.group(1)) if m else 0
def classify(n):
    L, k = n[0], num(n)
    if L == 'G': return 'park' if n != 'G105' else ''
    if L == 'M': return 'in'
    if L in 'AEFZ': return 'du'
    if L == 'B': return '' if n.startswith('BC') else ('du' if k <= 24 else 'cc')
    if L == 'D': return 'du' if k <= 21 else 'cc'
    if L == 'C':
        if n in ('C436', 'C509'): return ''
        if n == 'C343': return 'ccdu'
        if k <= 44 or 300 <= k <= 340: return 'du'
        return 'cc'
    return ''
def vehicle(n):
    L, k = n[0], num(n)
    if L in 'AF': return True
    if L == 'B': return 1 <= k <= 24 and n != 'B002'
    if L == 'C': return (1 <= k <= 13 and n != 'C001') or 24 <= k <= 44 or 300 <= k <= 339
    if L == 'D': return k <= 19
    if L == 'E': return k <= 18
    return False
for u in units:
    u['k'] = classify(u['n']); u['veh'] = 1 if vehicle(u['n']) else 0
    u['wm'] = round(u['w'] * FT, 2); u['dm'] = round(u['d'] * FT, 2)

def natkey(n):
    m = re.match(r'([A-Z]+)(\d+)([A-Z]*)', n)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (n, 0, '')
units.sort(key=lambda u: natkey(u['n']))

placed = []
flags = []

def place(u, bid, floor, u0, v0, w, d, door):
    # Geometry: u,v = corner, wu = size along u, dv = size along v (meters).
    # Occupancy from Cubby: l leased, r rentable, why/note, dvac = days vacant.
    placed.append({**{k: u[k] for k in ('n', 'w', 'd', 'k', 'veh', 'pw', 'l', 'r', 'why', 'note')}, 'dvac': u.get('dv', 0),
                   'b': bid, 'f': floor, 'u': round(u0, 2), 'v': round(v0, 2),
                   'wu': round(w, 2), 'dv': round(d, 2), 'door': door})

def take_row(items, i, ua, ub):
    row = []; uu = ua; rowd = 0.0
    while i < len(items):
        x = items[i]; w, d = x['wm'], x['dm']
        if w <= 0.3: w, d = 1.0, 1.0            # mailbox / unsized cell
        if uu + w > ub + 0.01: break
        row.append((x, uu, w, d)); uu += w; rowd = max(rowd, d); i += 1
    return row, rowd, i

def fill_rows(bd, items, i, floor, ua, ub, iv0, iv1):
    """Double-loaded corridors: row A (doors toward +v), corridor, row B (doors toward -v), back to back."""
    v = iv0
    while i < len(items):
        rowA, dA, iA = take_row(items, i, ua, ub)
        if not rowA:
            flags.append(f"{bd['id']}: unit {items[i]['n']} is wider than the building"); i += 1; continue
        rowB, dB, iB = take_row(items, iA, ua, ub)
        need = dA + CORRIDOR + dB
        if v + need > iv1 + 0.01:
            if v > iv0 + 0.01: return i            # next floor retries this row
            if rowB and v + dA + CORRIDOR <= iv1 + 0.01:   # only row A fits here
                rowB, dB, iB = [], 0.0, iA; need = dA + CORRIDOR
            else:
                return i
        for x, uu, w, d in rowA: place(x, bd['id'], floor, uu, v, w, d, 'ne')
        for x, uu, w, d in rowB: place(x, bd['id'], floor, uu, v + dA + CORRIDOR + (dB - d), w, d, 'sw')
        v += need; i = iB
    return i

def layout_building(bd, items):
    u0, u1 = bd['u']; v0, v1 = bd['v']; Wd = v1 - v0
    du = [x for x in items if x['k'] in ('du', 'ccdu')]
    inner = [x for x in items if x['k'] not in ('du', 'ccdu')]
    # Same-depth units share a row so a row is never as deep as its one deepest unit.
    inner.sort(key=lambda x: (-x['dm'], natkey(x['n'])))
    side = bd.get('doorSide', 'both')
    primary = 'sw' if side in ('sw', 'both') else 'ne'
    secondary = 'ne' if primary == 'sw' else 'sw'
    for x in du:
        if x['wm'] <= 0: x['wm'], x['dm'] = 3.05, 3.05
    full = [x for x in du if x['dm'] >= 0.8 * Wd]
    part = sorted([x for x in du if x['dm'] < 0.8 * Wd], key=lambda x: (-x['dm'], natkey(x['n'])))  # deep ones take the main wall
    floor = 1; i = 0
    full_until = u0; cur = {'sw': u0, 'ne': u0}; strip = {'sw': 0.0, 'ne': 0.0}
    pending = full + part
    while pending:
        rest = []
        for x in pending:
            w, d = x['wm'], x['dm']
            if x in full:
                start = max(cur['sw'], cur['ne'])
                if start + w <= u1 + 0.01:
                    place(x, bd['id'], floor, start, v0, w, Wd, primary)
                    cur['sw'] = cur['ne'] = start + w
                    if floor == 1: full_until = start + w
                else: rest.append(x)
            else:
                done = False
                for wall in (primary, secondary):
                    if cur[wall] + w <= u1 + 0.01:
                        place(x, bd['id'], floor, cur[wall], v0 if wall == 'sw' else v1 - d, w, d, wall)
                        cur[wall] += w; strip[wall] = max(strip[wall], d); done = True; break
                if not done: rest.append(x)
        if rest:
            flags.append(f"{bd['id']}: {len(rest)} drive-up units overflow the walls on floor {floor} ({rest[0]['n']}..) - moved to floor {floor + 1}")
            floor += 1; cur = {'sw': u0, 'ne': u0}; strip = {'sw': 0.0, 'ne': 0.0}
        pending = rest
    floors_used = floor
    if inner:
        f = 1
        i = fill_rows(bd, inner, 0, 1, full_until, u1, v0 + strip['sw'] if floors_used == 1 else v0, v1 - strip['ne'] if floors_used == 1 else v1)
        while i < len(inner):
            f += 1
            j = fill_rows(bd, inner, i, f, u0, u1, v0, v1)
            if j == i:
                flags.append(f"{bd['id']}: unit {inner[i]['n']} does not fit the building width"); i += 1
            else: i = j
        floors_used = max(floors_used, f)
    if floors_used > bd.get('floors', 1):
        flags.append(f"{bd['id']}: schematic needs {floors_used} levels for the unit area (configured {bd.get('floors', 1)}) - confirm the real floor count")
        bd['floors'] = floors_used
    bd['floorsUsed'] = floors_used

def poly_contains(poly, p):
    x, y = p; c = False; j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi): c = not c
        j = i
    return c

def layout_lot(zone, items):
    poly = zone['uv']
    us = [p[0] for p in poly]; vs = [p[1] for p in poly]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    i = 0; v = v0 + 0.5; row_i = 0
    while i < len(items) and v < v1:
        rowd = max(x['dm'] for x in items[i:i + 40]) or 9.0
        uu = u0 + 0.5; placed_any = False
        while i < len(items) and uu < u1:
            x = items[i]; w = x['wm'] or 3.6; d = x['dm'] or 9.0
            c = (uu + w / 2, v + rowd / 2)
            if poly_contains(poly, c):
                place(x, zone['id'], 1, uu, v, w, d, 'sw' if row_i % 2 else 'ne'); i += 1; placed_any = True
            uu += w
        v += rowd + (AISLE if row_i % 2 else 0.6); row_i += 1
        if not placed_any and v > v1: break
    if i < len(items):
        flags.append(f"{zone['id']}: {len(items) - i} stalls placed in an overflow row outside the drawn lot ({items[i]['n']}..) - lot outline needs the as-built")
        uu = u0 + 0.5; rowd = max(x['dm'] for x in items[i:]) or 9.0
        while i < len(items):
            x = items[i]; w = x['wm'] or 3.6; d = x['dm'] or 9.0
            if uu + w > u1: uu = u0 + 0.5; v += rowd + AISLE
            place(x, zone['id'], 1, uu, v, w, d, 'ne'); i += 1; uu += w

# ---- geometry prep ----
for bd in cfg['buildings']: bd['ll'] = [uv_to_ll(bd['u'][a], bd['v'][c]) for a, c in ((0,0),(1,0),(1,1),(0,1))]
for z in cfg['zones']: z['uv'] = [px_to_uv(*p) for p in z['px']]
cfg['pad']['uv'] = [px_to_uv(*p) for p in cfg['pad']['px']]
for g in cfg['gates']: g['uv'] = px_to_uv(*g['px'])
ring = parcel['coordinates'][0] if parcel['type'] == 'Polygon' else parcel['coordinates'][0][0]
parcel_uv = [ll_to_uv(*p[:2]) for p in ring]
img_uv = [px_to_uv(0, 0), px_to_uv(pw, 0), px_to_uv(pw, ph), px_to_uv(0, ph)]
wide = cfg.get('imageWide')
if wide:
    w0, s0, e0, n0 = wide['bbox']
    wide['uv'] = [ll_to_uv(w0, n0), ll_to_uv(e0, n0), ll_to_uv(e0, s0), ll_to_uv(w0, s0)]

# ---- assign units ----
by_letter = {}
for u in units: by_letter.setdefault(u['n'][0], []).append(u)
for bd in cfg['buildings']:
    items = [x for L in bd['letters'] for x in by_letter.get(L, [])]
    layout_building(bd, items)
G = by_letter.get('G', [])
layout_lot(cfg['zones'][0], [x for x in G if num(x['n']) <= 78])
layout_lot(cfg['zones'][1], [x for x in G if num(x['n']) > 78])
missing = sorted(set(u['n'] for u in units) - set(p['n'] for p in placed), key=natkey)
if missing: flags.append(f"{len(missing)} units not placed: {', '.join(missing[:12])}")

north = [round(cu, 4), round(su, 4)]  # true north as a unit vector in (u,v)

site = {
    'property': {k: cfg[k] for k in ('id', 'name', 'address', 'apn', 'acreage', 'opened', 'cubbyFacilityId')},
    'frame': {**fr, 'north': north},
    'image': {**{k: img[k] for k in ('bbox', 'px', 'attribution')}, 'uv': img_uv},
    'imageWide': ({'bbox': wide['bbox'], 'uv': wide['uv']} if wide else None),
    'parcel': parcel_uv, 'pad': cfg['pad']['uv'],
    'gates': [{k: g[k] for k in ('id', 'name', 'uv')} for g in cfg['gates']],
    'buildings': [{k: bd[k] for k in ('id', 'letters', 'name', 'kind', 'u', 'v', 'height', 'floors', 'roof', 'inferred', 'note', 'll')} for bd in cfg['buildings']],
    'zones': [{k: z[k] for k in ('id', 'name', 'kind', 'uv')} for z in cfg['zones']],
    'units': placed,
    'layout': {'schematic': True, 'flags': flags, 'generated': 'Oct 11, 2026'},
    'sources': cfg['sources'],
}
json.dump(site, open(out_path, 'w'), separators=(',', ':'))
print('units placed', len(placed), 'of', len(units))
for f in flags: print('FLAG', f)
for bd in cfg['buildings']:
    n = sum(1 for p in placed if p['b'] == bd['id'])
    area = sum(p['w'] * p['d'] for p in placed if p['b'] == bd['id'])
    print(bd['id'], 'units', n, 'rentable sqft', area, 'footprint sqft', round((bd['u'][1]-bd['u'][0])*(bd['v'][1]-bd['v'][0])*10.764), 'floors', bd['floors'])
print('parcel pts', len(parcel_uv), 'north', north, 'img corners', img_uv)
