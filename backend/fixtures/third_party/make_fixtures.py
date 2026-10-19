"""Builds the CubeSmart report fixtures in this folder (Operations, Oct 20 2026).

    python make_fixtures.py

The layouts copy what Neil showed on the Oct 20 Ops call: the Qlik "SRE
Summary" sheet (qsreports.cubesmart.com - Rental Activity, then Revenue &
AR, one column per month), the SmartView "Daily Flash Landing Page" tables
(smartviewweb.cubesmart.com/flash) and the Rent Roll sheet of the monthly
Financials workbook. The Rental Activity, Occupancy by Status, Revenue and
Net Rentals figures are the ones on screen for 10/19/2026; the Revenue & AR
lines were below the fold, so their labels and values are illustrative and
are checked against a real export before go-live. Every tenant name is made
up. No credentials, no live data.
"""
import csv
import os
import random

from openpyxl import Workbook

HERE = os.path.dirname(os.path.abspath(__file__))

MONTHS = ["Oct-2026", "Sep-2026", "Aug-2026", "Jul-2026", "Jun-2026", "May-2026", "Apr-2026", "Mar-2026",
          "Feb-2026", "Jan-2026", "Dec-2025", "Nov-2025", "Oct-2025", "Sep-2025", "Aug-2025"]
ACTIVITY = [
    ("Tot Cubes Avail", [2926, 2926, 2944, 2954, 2960, 2985, 2992, 2992, 3010, 3011, 3011, 3011, 3011, 3011, 3011]),
    ("Rented During Month", [42, 105, 116, 118, 145, 137, 126, 110, 90, 106, 125, 99, 103, 115, 100]),
    ("Vacated During Month", [58, 120, 108, 111, 96, 93, 99, 105, 90, 121, 97, 105, 130, 115, 129]),
    ("Net Rentals", [-16, -15, 8, 7, 49, 44, 27, 5, 0, -15, 28, -6, -27, 0, -29]),
    ("Total Company Cubes", [0] * 15),
    ("Tot Maint Cubes", [1, 1, 1, 0, 1, 1, 0, 0, 0, 2, 2, 3, 2, 1, 3]),
    ("Cubes Occ at EOM", [2491, 2507, 2522, 2514, 2507, 2458, 2414, 2387, 2382, 2382, 2397, 2369, 2375, 2402, 2402]),
    ("Tot % Rented - Cube", ["85.1%", "85.7%", "85.7%", "85.1%", "84.7%", "82.3%", "80.7%", "79.8%", "79.1%", "79.1%", "79.6%", "78.7%", "78.9%", "79.8%", "79.8%"]),
    ("Tot % Rented - SqF", ["91.7%", "92.7%", "93.0%", "93.0%", "92.7%", "90.7%", "89.3%", "88.1%", "87.5%", "86.9%", "87.7%", "85.9%", "86.3%", "87.4%", "87.7%"]),
    ("% NCC", ["93.1%", "95.4%", "98.9%", "95.4%", "96.6%", "96.6%", "96.6%", "96.6%", "97.7%", "97.7%", "95.4%", "89.7%", "83.9%", "81.6%", "86.2%"]),
    ("% CC", ["84.9%", "85.4%", "85.3%", "84.8%", "84.3%", "81.9%", "80.2%", "79.3%", "78.6%", "78.6%", "79.1%", "78.4%", "78.7%", "79.7%", "79.6%"]),
    ("% UP", ["83.6%", "84.0%", "84.0%", "83.0%", "82.4%", "79.5%", "77.3%", "76.4%", "76.1%", "76.2%", "76.7%", "76.2%", "76.3%", "77.5%", "77.2%"]),
    ("% DOWN", ["90.4%", "91.7%", "91.7%", "92.8%", "92.8%", "92.5%", "92.6%", "91.7%", "89.9%", "89.5%", "90.1%", "87.7%", "88.0%", "88.0%", "89.2%"]),
    ("% ANNEX", ["NA"] * 15),
]
REVENUE = [
    ("Rental Revenue", [173504, 187220, 186905, 185110, 182640, 178300, 174015, 171880, 170420, 169955, 171210, 168730, 166957, 168400, 167900]),
    ("Fee Revenue", [9921, 10850, 11020, 10760, 11400, 10980, 10510, 9970, 9540, 9880, 10120, 9450, 8771, 9020, 9110]),
    ("Insurance Revenue", [8364, 12890, 12850, 12790, 12610, 12350, 12110, 11960, 11870, 11820, 11890, 11730, 6773, 11600, 11550]),
    ("Merchandise Revenue", [973, 1640, 1590, 1720, 1810, 1660, 1550, 1430, 1210, 1180, 1320, 1250, 1101, 1300, 1290]),
    ("Total Revenue", [192762, 212600, 212365, 210380, 208460, 203290, 198185, 195240, 193040, 192835, 194540, 191160, 183602, 190320, 189850]),
    ("Promotions", ["(3,133)", "(5,940)", "(6,210)", "(6,050)", "(7,320)", "(6,880)", "(6,410)", "(5,720)", "(4,930)", "(5,210)", "(5,870)", "(4,990)", "(4,669)", "(5,100)", "(5,020)"]),
    ("Promo Move Ins", [31, 78, 85, 87, 109, 101, 93, 80, 66, 77, 92, 71, 75, 84, 73]),
    ("Write Offs", ["(1,227)", "(1,960)", "(1,840)", "(2,110)", "(1,650)", "(1,720)", "(1,880)", "(2,040)", "(1,930)", "(2,210)", "(1,780)", "(1,690)", "(1,268)", "(1,820)", "(1,910)"]),
    ("AR 0-30", [6210, 6890, 7020, 6750, 6610, 6980, 7100, 6870, 6540, 6720, 6910, 6630, 6480, 6550, 6700]),
    ("AR 31-60", [2140, 2310, 2280, 2190, 2050, 2240, 2310, 2180, 2090, 2160, 2230, 2120, 2070, 2110, 2150]),
    ("AR 61-90", [880, 940, 910, 870, 820, 900, 950, 890, 860, 880, 910, 860, 840, 850, 870]),
    ("AR 91+", [410, 450, 430, 400, 380, 420, 440, 410, 390, 400, 420, 390, 380, 390, 400]),
    ("Total AR", [9640, 10590, 10640, 10210, 9860, 10540, 10800, 10350, 9880, 10160, 10470, 10000, 9770, 9900, 10120]),
]


def sre_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.title = "SRE"
    ws.append(["SRE Summary as of 10/19/2026 8:16:49 AM"])
    ws.append(["Store", "6992 - Austin TX (Parmer Ln)"])
    ws.append([])
    ws.append(["Rental Activity"])
    ws.append(["Values", "Month - Year"])
    ws.append([""] + MONTHS)
    ws.append(["Budget SF Occupancy", "89.0%", "89.0%", "89.3%", "92.0%"] + [None] * 11)
    for label, vals in ACTIVITY:
        ws.append([label] + vals)
    ws.append(["LOS (Days)", 399] + [None] * 14)
    ws.append([])
    ws.append(["Revenue & AR"])
    ws.append(["Values", "Month - Year"])
    # Qlik lets the viewer re-sort the months: the second table runs oldest first.
    ws.append([""] + list(reversed(MONTHS)))
    for label, vals in REVENUE:
        ws.append([label] + list(reversed(vals)))
    wb.save(os.path.join(HERE, "cubesmart_sre_summary.xlsx"))


def sre_long_csv():
    """The same report pivoted the other way (one row per month), columns in
    a different order, for Sachse (store 4568)."""
    cols = ["Net Rentals", "Month", "Cubes Occ at EOM", "Store", "Vacated During Month", "Tot Cubes Avail",
            "Rented During Month", "Tot % Rented - SqF", "Rental Revenue", "Total AR"]
    rows = [
        ["-3", "Sep-2026", "742", "4568", "31", "886", "28", "88.4%", "$71,240.00", "$4,120.00"],
        ["5", "Aug-2026", "745", "4568", "24", "886", "29", "88.9%", "$71,580.00", "$3,980.00"],
        ["2", "Jul-2026", "740", "4568", "27", "886", "29", "88.1%", "$70,910.00", "$4,310.00"],
    ]
    with open(os.path.join(HERE, "cubesmart_sre_summary_long.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def flash_xlsx():
    """The Daily Flash tables as they sit on the landing page, stacked."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Daily Flash"
    ws.append(["Daily Flash Landing Page as of 10/19/2026 10:28:40 AM"])
    ws.append(["Store", 6992])
    ws.append([])
    ws.append(["Revenue", "MTD", "Budget", "Variance", "Prior Year"])
    ws.append(["Accrued Rent", "173,504", "173,841", "-336", "166,957"])
    ws.append(["Fees", "9,921", "7,262", "2,659", "8,771"])
    ws.append(["Insurance", "8,364", "8,109", "254", "6,773"])
    ws.append(["Merchandise", "973", "1,666", "-694", "1,101"])
    ws.append(["Totals", "192,761", "190,878", "1,883", "183,602"])
    ws.append([])
    ws.append(["Allowances", "MTD", "Budget", "Variance", "Prior Year"])
    ws.append(["Discount", "-3,133", "-4,621", "1,488", "-4,669"])
    ws.append(["Write Offs", "-1,227", "-1,195", "-32", "-1,268"])
    ws.append(["Totals", "-4,360", "-5,816", "1,456", "-5,937"])
    ws.append([])
    ws.append(["Net Revenue"])
    ws.append(["MTD", "Budget", "Variance", "Prior Year"])
    ws.append(["188,402", "185,062", "3,339", "177,665"])
    ws.append([])
    ws.append(["Occupancy by Status"])
    # Qlik shows the columns in whatever order the sheet was built; this one puts SQFT first.
    ws.append(["", "SQFT", "SQFT %", "Cubes", "UNIT %"])
    ws.append(["Totals", "316,874", "100.00%", "2,926", "100.00%"])
    ws.append(["Occupied", "290,558", "91.69%", "2,491", "85.13%"])
    ws.append(["Vacant", "23,613", "7.45%", "414", "14.15%"])
    ws.append(["Reserved", "1,255", "0.40%", "9", "0.31%"])
    ws.append(["Damaged", "25", "0.01%", "1", "0.03%"])
    ws.append(["Unrentable", "1,424", "0.45%", "11", "0.38%"])
    ws.append([])
    ws.append(["Net Rentals"])
    ws.append(["", "Daily", "Daily Budget", "MTD", "MTD Budget", "MTD Prior Year"])
    ws.append(["MoveIns", 3, 1, 42, 60, 59])
    ws.append(["MoveOuts", 1, 0, 58, 61, 64])
    ws.append(["Net Rentals", 2, 1, -16, -1, -5])
    wb.save(os.path.join(HERE, "cubesmart_daily_flash.xlsx"))


def flash_long_csv():
    """One row per day (a SmartView export of the Net Rentals and occupancy
    figures), Georgetown (store 6093), columns shuffled."""
    cols = ["Move Ins MTD", "Date", "Store", "Occupied Cubes", "Vacant Cubes", "Total Cubes", "Move Outs MTD",
            "Accrued Rent MTD", "Accrued Rent Budget", "Accrued Rent Prior Year", "Reserved Cubes", "Damaged Cubes",
            "Unrentable Cubes", "Move Ins Daily", "Move Outs Daily"]
    rows = [
        ["9", "10/17/2026", "6093", "801", "151", "964", "11", "61,204", "62,000", "58,330", "4", "2", "6", "1", "0"],
        ["10", "10/18/2026", "6093", "802", "150", "964", "11", "64,881", "65,700", "61,840", "4", "2", "6", "1", "0"],
    ]
    with open(os.path.join(HERE, "cubesmart_daily_flash_long.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def rent_roll_csv():
    """A Rent Roll with the customer columns in it (made-up names), columns
    re-ordered: only Store, Cube, Cube Dimensions and Cube Attribute are read."""
    rnd = random.Random(20261020)
    cols = ["Customer Name", "Cube Attribute", "Store", "Rent Rate", "Cube", "Move In Date", "Cube Dimensions", "Paid Thru"]
    units = ["1000", "1001", "1003-1004", "2001", "2002", "3010", "5052", "5193-94", "9001"]
    with open(os.path.join(HERE, "cubesmart_rent_roll.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Rent Roll as of 09/30/2026"])
        w.writerow(cols)
        for i, n in enumerate(units):
            w.writerow([f"Fixture Tenant {i + 1}", "CE" if n[0] != "1" else "CD", "6992", f"{rnd.randint(90, 260)}.00", n,
                        "03/0{}/2025".format(1 + i % 9), "10X15" if i % 2 else "10X10", "10/31/2026"])
        # one malformed row: a name where the unit should be (never echoed back)
        w.writerow(["Fixture Tenant 99", "CE", "6992", "120.00", "FIXTURE TENANT NAME", "03/01/2025", "", "10/31/2026"])


def financials_xlsx():
    """The monthly Financials workbook's Rent Roll sheet (CubeSmart's own
    layout: Store, Cube, Cube Dimensions, Cube Attribute, then customer data)."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Rent Roll"
    ws.append(["Store", "Cube", "Cube Dimensions", "Cube Attribute", "Customer Name", "Move In", "Rate"])
    for i, (n, size, attr) in enumerate([("1000", "10X35", "CD"), ("1001", "10X30", "CD"), ("2001", "10X10", "CE"),
                                         ("5052", "10X15", "CE")]):
        ws.append([6992, n, size, attr, f"Fixture Tenant {i + 1}", "2025-01-01", 150 + i])
    ws.append([4568, "1101", "5X10", "CE", "Fixture Tenant 50", "2025-01-01", 80])   # another store: filtered out
    wb.create_sheet("Cube Mix").append(["Store", "Size", "Attribute", "", "Total"])
    wb.save(os.path.join(HERE, "cubesmart_financials_2026-09-30.xlsx"))


if __name__ == "__main__":
    sre_xlsx()
    sre_long_csv()
    flash_xlsx()
    flash_long_csv()
    rent_roll_csv()
    financials_xlsx()
    print("fixtures written to", HERE)
