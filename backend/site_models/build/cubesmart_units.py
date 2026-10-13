"""CubeSmart rent roll -> site-model units.json (Site Models, Oct 2026).

    python cubesmart_units.py <Financials.xlsx> <store> <as-of MM/DD/YYYY> <out.units.json> [<sizes.json> <sizes as-of>]

For the stores CubeSmart operates (Austin 6992, Sachse 4568, Georgetown 6093),
which are not in Cubby. The input is CubeSmart's monthly "Financials" workbook
(Egnyte: <entity>/#Reports/Reports - Daily & Monthly/<year>/<month>/<store>/).
Only two sheets are read, and only these columns:

  Rent Roll  Store, Cube, Cube Dimensions, Cube Attribute  (columns A-D)
  Cube Mix   per size and attribute: total, vacant, reserved, occupied ...

The Rent Roll sheet also holds customer names, dates and rates: they are never
read, so they never reach the model (rent rolls carry customer PII).

The rent roll lists occupied units only. Every other unit number on a floor
(a gap in the numbering) is written as vacant, and its size is ESTIMATED: the
Cube Mix says how many vacant units of each size and attribute there are, and
each gap takes the size of that pool closest to its numbered neighbors. Those
units carry the note "size estimated" so nobody mistakes it for a measurement.
An optional sizes file ({"unit": "10X15", ...}, e.g. from an older all-units
audit) gives a gap its listed size instead; it is checked against the rent roll
and refused when the two disagree on more than a few units.

Cube Attribute codes: 1st letter C climate controlled / N not; 2nd letter
D ground floor, E elevator (upper floors), O outside drive-up, X locker.
"""
import json
import re
import sys
import warnings
from collections import Counter, defaultdict

JUMP = 40
NAME = re.compile(r'^(\d)(\d{3})(?:-(\d{2,4}))?([A-Z]?)$')


def read_workbook(path, store):
    import openpyxl
    warnings.filterwarnings('ignore')
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    occ = [{'n': str(r[1]).strip().upper(), 'size': str(r[2]).strip(), 'attr': str(r[3]).strip()}
           for r in wb['Rent Roll'].iter_rows(values_only=True, max_col=4)
           if str(r[0]) == str(store) and r[1] is not None]
    check_shape(occ)
    mix = [{'size': r[1], 'attr': r[2], 'total': int(r[4] or 0), 'occ': int(r[8] or 0)}
           for r in wb['Cube Mix'].iter_rows(values_only=True, max_col=9) if str(r[0]) == str(store)]
    return occ, mix


CUBE = re.compile(r'[0-9A-Z-]{1,12}')
SIZE = re.compile(r'\d+(\.\d+)?\s*[Xx]\s*\d+(\.\d+)?')


def check_shape(occ):
    """Columns A-D are read by position: if CubeSmart ever reorders the Rent Roll,
    a customer name or a date would land in the unit number. Refuse any row whose
    Cube is not unit-shaped or whose dimensions are not WxD - and report a count
    only, never the cell values (they could be customer data)."""
    bad = sum(1 for r in occ if not CUBE.fullmatch(r['n']) or not SIZE.fullmatch(r['size']))
    if bad:
        raise SystemExit(f'Rent Roll columns A-D do not look like Store, Cube, Cube Dimensions, Cube Attribute '
                         f'on {bad} of {len(occ)} rows - check the workbook layout before building')


def numbers(name):
    """'1003-1004' -> [1003, 1004]; '5193-94' -> [5193, 5194]; ('1001L' -> series 'L')."""
    m = NAME.match(name)
    if not m:
        return None, []
    a = int(m.group(1) + m.group(2))
    if m.group(3):
        tail = m.group(3)
        b = int(str(a)[:len(str(a)) - len(tail)] + tail)
        return m.group(4), list(range(a, b + 1))
    return m.group(4), [a]


def dims(size):
    w, d = (str(size).upper().split('X') + ['0'])[:2]
    return float(w or 0), float(d or 0)


def klass(attr):
    return (attr or '')[:2]


def unit(n, size, attr, leased, note=''):
    w, d = dims(size)
    return {'n': n, 'w': w, 'd': d, 't': 'S', 'l': 1 if leased else 0, 'r': 1, 'why': '', 'note': note,
            'dv': 0, 'pw': 0, 'cc': 1 if attr[:1] == 'C' else 0, 'du': 1 if attr[1:2] == 'O' else 0, 'cov': 0}


def build(occ, mix, asof, known=None, known_asof=''):
    known = {k.upper(): str(v).upper() for k, v in (known or {}).items()}
    units, taken, series = [], {}, defaultdict(list)
    for r in occ:
        units.append(unit(r['n'], r['size'], r['attr'], True))
        sfx, nums = numbers(r['n'])
        if not nums:
            continue
        for x in nums:
            taken[(sfx, x)] = r
        series[(sfx, nums[0] // 1000)].extend(nums)
    # vacant pool per (attr class, size) = total - occupied, from the Cube Mix
    pool = Counter()
    for m in mix:
        free = m['total'] - m['occ']
        if free > 0:
            pool[(klass(m['attr']), str(m['size']).upper(), m['attr'])] += free
    gaps = []
    for (sfx, floor), nums in series.items():
        # a floor can hold several numbering blocks (Georgetown: 1001-1157 inside,
        # 1500-1538 drive-up); a jump of more than JUMP numbers starts a new block
        nums = sorted(set(nums)); start = nums[0]
        for a, b in zip(nums, nums[1:] + [None]):
            if b is None or b - a > JUMP:
                for x in range(start, a + 1):
                    if (sfx, x) not in taken:
                        gaps.append((sfx, x))
                start = b

    def neighbors(sfx, x):
        out = []
        for step in range(1, 40):
            for y in (x - step, x + step):
                r = taken.get((sfx, y))
                if r and y // 1000 == x // 1000:
                    out.append((step, r))
            if len(out) >= 4:
                break
        return out

    if known:
        clash = [r['n'] for r in occ if r['n'] in known and dims(known[r['n']]) != dims(r['size'])]
        if len(clash) > max(3, len(occ) // 100):
            raise SystemExit(f'sizes file disagrees with the rent roll on {len(clash)} units, e.g. {clash[:5]}')
    est, unknown, listed = 0, 0, 0
    rest = []
    for g in gaps:
        name = f'{g[1]}{g[0] or ""}'
        nb = neighbors(*g)
        if name in known and nb:
            attr = nb[0][1]['attr']
            key = next((k for k in pool if k[0] == klass(attr) and dims(k[1]) == dims(known[name]) and pool[k] > 0), None)
            if key:
                pool[key] -= 1; attr = key[2]
            listed += 1
            units.append(unit(name, known[name], attr, False, f'Vacant on the {asof} rent roll; size from the {known_asof} unit audit'))
        else:
            rest.append(g)
    gaps_all, gaps = gaps, rest
    # most-constrained first: gaps whose neighbors agree on one size
    scored = []
    for g in gaps:
        nb = neighbors(*g)
        scored.append((nb[0][0] if nb else 99, g, nb))
    for _, (sfx, x), nb in sorted(scored):
        name = f'{x}{sfx or ""}'
        best, bestscore = None, None
        for (kc, size, attr), cnt in pool.items():
            if cnt <= 0:
                continue
            s = 0.0
            for dist, r in nb:
                wgt = 1.0 / dist
                s += wgt * (2 if klass(r['attr']) == kc else -6)
                s += wgt * (3 if str(r['size']).upper() == size else -abs(dims(size)[0] * dims(size)[1] - dims(r['size'])[0] * dims(r['size'])[1]) / 100)
            if bestscore is None or s > bestscore:
                best, bestscore = (kc, size, attr), s
        if best and nb and klass(nb[0][1]['attr']) == best[0]:
            pool[best] -= 1; est += 1
            units.append(unit(name, best[1], best[2], False, f'Vacant on the {asof} rent roll; size estimated from the unit mix'))
        else:
            attr = nb[0][1]['attr'] if nb else 'CE'
            unknown += 1
            units.append(unit(name, '0X0', attr, False, f'Vacant on the {asof} rent roll; size not listed'))
    left = sum(v for v in pool.values() if v > 0)
    units.sort(key=lambda u: (NAME.match(u['n']).group(4) if NAME.match(u['n']) else '', int(re.match(r'\d+', u['n']).group(0)) if re.match(r'\d+', u['n']) else 0))
    return units, {'occupied': len(occ), 'gaps': len(gaps_all), 'listed': listed, 'estimated': est, 'unknown': unknown,
                   'mixTotal': sum(m['total'] for m in mix), 'mixUnplaced': left,
                   'mixUnplacedBy': {f'{k[2]} {k[1]}': v for k, v in pool.items() if v > 0}}


def main(argv):
    src, store, asof, out = argv[1:5]
    if src.endswith('.json'):   # an already-reduced extract {occupied, mix}
        d = json.load(open(src)); occ, mix = d['occupied'], d['mix']
        mix = [{'size': m['size'], 'attr': m['attr'], 'total': m['total'], 'occ': m['occ']} for m in mix]
    else:
        occ, mix = read_workbook(src, store)
    known = json.load(open(argv[5])) if len(argv) > 5 else None
    units, stats = build(occ, mix, asof, known, argv[6] if len(argv) > 6 else '')
    json.dump(units, open(out, 'w'))
    print(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main(sys.argv)
