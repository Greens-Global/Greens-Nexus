"""The Credentials import template (Pranshu, 11/13/2026): an Excel file whose
Company column is a dropdown of the companies the person may use and whose
Department column lists only the departments of the company picked on that row,
so a sheet cannot name a company or department that does not exist.

How the dependent dropdown works: a hidden Lists sheet holds the companies
(column A) next to a range name of their own (B), and each company's
departments in a column of their own under that range name; the Department
cell's list is INDIRECT(VLOOKUP(company, Companies, 2, FALSE)). Type and Tier
are plain lists. The import wizard reads the headers as they are written here
(importModel.guessMap).
"""
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

HEADERS = ["Name", "Company", "Department", "Username", "Password", "Link", "Type", "Tier", "Notes"]
ROWS = 500   # rows that carry the dropdowns


def build(companies: list, departments: list, types, tiers) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Logins"
    ws.append(HEADERS)
    for i, h in enumerate(HEADERS, start=1):
        cell = ws.cell(row=1, column=i)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F7A3A")
        ws.column_dimensions[get_column_letter(i)].width = 28 if h in ("Name", "Company", "Department", "Link", "Notes") else 18
    ws.freeze_panes = "A2"

    lists = wb.create_sheet("Lists")
    lists.sheet_state = "hidden"
    lists["A1"], lists["B1"] = "Company", "Range"
    for n, co in enumerate(companies, start=1):
        rng = f"co_{n}"
        lists.cell(row=n + 1, column=1, value=co["name"])
        lists.cell(row=n + 1, column=2, value=rng)
        col = get_column_letter(n + 3)                       # D, E, F ... one column per company
        names = sorted({d["name"] for d in departments if d.get("companyId") == co["id"] and d.get("name")})
        lists[f"{col}1"] = co["name"]
        for r, dept in enumerate(names or ["(no departments set up)"], start=2):
            lists[f"{col}{r}"] = dept
        wb.defined_names[rng] = DefinedName(rng, attr_text=f"Lists!${col}$2:${col}${len(names or [0]) + 1}")
    last = max(len(companies), 1) + 1
    wb.defined_names["Companies"] = DefinedName("Companies", attr_text=f"Lists!$A$2:$B${last}")
    wb.defined_names["CompanyNames"] = DefinedName("CompanyNames", attr_text=f"Lists!$A$2:$A${last}")

    def listed(formula, col, title, prompt):
        dv = DataValidation(type="list", formula1=formula, allow_blank=True, showErrorMessage=True,
                            errorTitle=title, error=prompt)
        ws.add_data_validation(dv)
        dv.add(f"{col}2:{col}{ROWS + 1}")

    listed("CompanyNames", "B", "Pick a Company", "Pick a company from the list.")
    listed("INDIRECT(VLOOKUP($B2,Companies,2,FALSE))", "C", "Pick a Department",
           "Pick the company first, then one of its departments.")
    listed('"' + ",".join(types) + '"', "G", "Pick a Type", "Pick a type from the list.")
    listed('"' + ",".join(tiers) + '"', "H", "Pick a Tier", "Pick a tier from the list.")

    how = wb.create_sheet("How To")
    for line in (
        "One login per row on the Logins sheet. Name, Company, Department and Password are needed.",
        "Pick the Company first - Department then lists that company's departments only.",
        "Passwords that are weak or found in a known data breach are left out on import, with the reason.",
        "Type: Password, API key, Access key or Certificate. Tier: Standard, High or Critical (blank = Standard).",
        "Delete this file once it is imported - the passwords are in Credentials from then on.",
    ):
        how.append([line])
    how.column_dimensions["A"].width = 110

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
