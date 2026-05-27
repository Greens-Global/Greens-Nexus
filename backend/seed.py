from database import engine, SessionLocal
import models

models.Base.metadata.create_all(bind=engine)

db = SessionLocal()

if db.query(models.Task).count() == 0:
    tasks = [
        models.Task(id='TASK-001', title='Update financial report Q2', assignee='Sarah Johnson', project='Financial Reporting', due_date='2026-05-23', hours='4h est. / 2.5h actual', comment='Last: Working on final review (2 hours ago)', priority='High', status='In Progress', dept='Accounting', synced=True),
        models.Task(id='TASK-002', title='Review site concrete excavation', assignee='Michael Chen', project='Onsite Operations', due_date='2026-05-24', hours='2h est. / 2.0h actual', comment='Last: Soil inspection complete (1 day ago)', priority='High', status='In Progress', dept='OPS', synced=True),
        models.Task(id='TASK-003', title='Draft subcontractor legal framing agreement', assignee='Emily Rodriguez', project='Legal & Contracts', due_date='2026-05-25', hours='6h est. / 4.0h actual', comment='Last: Awaiting legal team review (3 hours ago)', priority='Medium', status='Needs Review', dept='Development', synced=True),
        models.Task(id='TASK-004', title='Regulatory permit filing Site-B', assignee='Emily Rodriguez', project='Regulatory Permitting', due_date='2026-05-22', hours='3h est. / 3.0h actual', comment='', priority='High', status='Overdue', dept='Development', synced=True),
        models.Task(id='TASK-005', title='Google Ads restructuring', assignee='Jessica Taylor', project='Marketing & Ads', due_date='2026-05-24', hours='4h est. / 2.5h actual', comment='Last: Setup keyword match types (4 hours ago)', priority='Medium', status='In Progress', dept='Marketing', synced=True),
        models.Task(id='TASK-006', title='IT firewall server patching', assignee='David Kim', project='IT Security', due_date='2026-05-26', hours='5h est. / 0h actual', comment='', priority='Low', status='In Progress', dept='IT Support', synced=False),
        models.Task(id='TASK-007', title='Submit Q2 vendor invoice report', assignee='Sarah Johnson', project='Accounting Audit', due_date='2026-05-25', hours='3h est. / 0h actual', comment='', priority='Medium', status='To Do', dept='Accounting', synced=True),
        models.Task(id='TASK-008', title='Audit site concrete deliveries', assignee='Marcus Vance', project='Material Logs', due_date='2026-05-21', hours='8h est. / 6h actual', comment='Last: Audit logs in progress (1 week ago)', priority='Low', status='To Do', dept='OPS', synced=True),
    ]
    db.add_all(tasks)

if db.query(models.PurchaseRequest).count() == 0:
    reqs = [
        models.PurchaseRequest(item='Premium Ready-Mix Concrete - 120 Cubic Yards', vendor='Apex Building Supplies', cost=120, qty=120, dept='OPS', status='pending'),
        models.PurchaseRequest(item='Architectural Consulting Fees - Phase 3', vendor='Studio-D Designs', cost=5000, qty=1, dept='Development', status='pending'),
        models.PurchaseRequest(item='Heavy Duty Excavation Equipment Rental', vendor='Herc Rentals', cost=1850, qty=2, dept='OPS', status='pending'),
        models.PurchaseRequest(item='Autodesk AutoCAD Core Team Subscriptions', vendor='Autodesk Reseller', cost=1680, qty=6, dept='IT', status='pending'),
        models.PurchaseRequest(item='Corporate Financial Audit Consulting', vendor='Deloitte LLP', cost=8500, qty=1, dept='Accounting', status='pending'),
        models.PurchaseRequest(item='Google Local Service Ads - Q2 Budget Boost', vendor='Google Ads', cost=4200, qty=1, dept='Marketing', status='approved'),
    ]
    db.add_all(reqs)

if db.query(models.Review).count() == 0:
    reviews = [
        models.Review(name='John Smith', property='Harbor View Condos', platform='Google', date='2 hours ago', rating=5, comment="Excellent service and professional team! The quality of construction is outstanding. We moved in last month and couldn't be happier with our new home.", replied=False, ai_reply="Thank you so much for your wonderful review, John! We're thrilled to hear you're enjoying your new home at Harbor View Condos.", badge='New Review', badge_color='red', is_new=True),
        models.Review(name='Jane Doe', property='Downtown Complex', platform='Google', date='1 day ago', rating=4, comment='Great experience overall. The team was responsive and professional.', replied=False, ai_reply="Thank you for your feedback, Jane! We're glad you had a positive experience.", badge='AI Reply Suggested', badge_color='gray', is_new=False),
        models.Review(name='Marcus Brody', property='Downtown Commercial Complex', platform='Google', date='5 days ago', rating=3, comment='The construction noise at the downtown project starts a bit too early.', replied=False, ai_reply='Thank you for your feedback, Marcus. We apologize for any inconvenience caused by construction noise.', badge='', badge_color='', is_new=False),
        models.Review(name='Sarah Jenkins', property='Oakridge Subdivision Phase 1', platform='Google', date='2 hours ago', rating=5, comment='Greens Nexus did an outstanding job developing our retail complex.', replied=True, reply_text='Thank you Sarah! It was a pleasure working with you on this project.'),
        models.Review(name='David Vance', property='Onsite Development Site-B', platform='Google', date='1 day ago', rating=4, comment='Excellent build quality on our custom home.', replied=True, reply_text="We appreciate the feedback, David! Our onsite teams always strive to maintain clear communication."),
        models.Review(name='Amir Al-Mansoori', property='North Industrial Warehouse', platform='Google', date='2 days ago', rating=5, comment='Professional real estate developers who know the local market inside out.', replied=True, reply_text='Thank you Amir! Navigating local permits is one of our specialties.'),
        models.Review(name='Elena Rostova', property='Downtown Office Renovation', platform='Google', date='1 week ago', rating=4, comment='Very satisfied with our office renovation project.', replied=True, reply_text="Thank you for the review, Elena! We are glad you are happy with the renovation."),
        models.Review(name='Robert Chen', property='Harbor View Residential', platform='Google', date='1 week ago', rating=5, comment='Greens Nexus project management is stellar.', replied=True, reply_text='Thank you Robert! Safety and efficiency are our core values.'),
    ]
    db.add_all(reviews)

if db.query(models.MarketingCampaign).count() == 0:
    campaigns = [
        models.MarketingCampaign(name='Harbor View - Search Ads', property='Harbor View', platform='Google Search', impressions=45230, clicks=1420, conversions=68, abandoned_carts=112, spend=1250, cost_per_conv=18.38, status='Active'),
        models.MarketingCampaign(name='Downtown Complex - Display', property='Downtown Complex', platform='Google Display', impressions=38150, clicks=980, conversions=42, abandoned_carts=89, spend=890, cost_per_conv=21.19, status='Active'),
        models.MarketingCampaign(name='Residential Towers - Remarketing', property='Residential Towers', platform='Remarketing', impressions=21420, clicks=865, conversions=51, abandoned_carts=78, spend=1180, cost_per_conv=23.14, status='Active'),
        models.MarketingCampaign(name='Commercial Spaces - Shopping', property='Commercial Spaces', platform='Google Shopping', impressions=12580, clicks=542, conversions=18, abandoned_carts=45, spend=680, cost_per_conv=37.78, status='Active'),
        models.MarketingCampaign(name='Luxury Condos - YouTube', property='Luxury Condos', platform='YouTube Ads', impressions=7203, clicks=231, conversions=8, abandoned_carts=18, spend=250, cost_per_conv=31.25, status='Paused'),
    ]
    db.add_all(campaigns)

if db.query(models.SopUpdate).count() == 0:
    sops = [
        models.SopUpdate(title='IT Security Policy v2.1', category='IT Procedures', status='Published', date='2026-05-20'),
        models.SopUpdate(title='Financial Reporting Guidelines', category='Accounting Guidelines', status='Under Review', date='2026-05-19'),
        models.SopUpdate(title='Site Safety Checklist', category='Safety Protocols', status='Published', date='2026-05-18'),
        models.SopUpdate(title='Code Review Process', category='Development Standards', status='Published', date='2026-05-17'),
    ]
    db.add_all(sops)

if db.query(models.Asset).count() == 0:
    assets = [
        models.Asset(name='Dell Latitude 5520', category='Laptop', assigned_to='John Doe', status='Checked Out', last_seen='2026-05-20'),
        models.Asset(name='iPhone 13 Pro', category='Mobile', assigned_to='Jane Smith', status='Checked Out', last_seen='2026-05-19'),
        models.Asset(name='MacBook Pro 16"', category='Laptop', assigned_to='Mike Johnson', status='Checked Out', last_seen='2026-05-20'),
        models.Asset(name='Dell Monitor 27"', category='Monitor', assigned_to='Unassigned', status='Available', last_seen='2026-05-18'),
        models.Asset(name='Logitech Keyboard', category='Accessory', assigned_to='Sarah Williams', status='Overdue', last_seen='2026-05-10'),
        models.Asset(name='HP Printer', category='Printer', assigned_to='OPS Dept', status='Checked Out', last_seen='2026-05-19'),
    ]
    db.add_all(assets)

if db.query(models.User).count() == 0:
    users = [
        models.User(name='John Mitchell', dept='IT', role='IT Manager', access_level='Admin', status='Active', last_login='2026-05-21 09:30 AM'),
        models.User(name='Sarah Johnson', dept='Accounting', role='Financial Controller', access_level='Manager', status='Active', last_login='2026-05-21 08:15 AM'),
        models.User(name='Michael Chen', dept='OPS', role='Operations Lead', access_level='Manager', status='Active', last_login='2026-05-20 04:30 PM'),
        models.User(name='Emily Rodriguez', dept='Development', role='Senior Developer', access_level='Development', status='Active', last_login='2026-05-21 10:00 AM'),
        models.User(name='David Park', dept='Marketing', role='Marketing Manager', access_level='Marketing', status='Active', last_login='2026-05-21 07:45 AM'),
        models.User(name='Lisa Thompson', dept='Accounting', role='Accountant', access_level='Accounting', status='Active', last_login='2026-05-20 09:20 PM'),
        models.User(name='Robert Kim', dept='OPS', role='Site Supervisor', access_level='OPS', status='Inactive', last_login='2026-05-15 11:00 AM'),
        models.User(name='Jennifer Lee', dept='Admin', role='HR Coordinator', access_level='View Only', status='Active', last_login='2026-05-21 08:00 AM'),
    ]
    db.add_all(users)

if db.query(models.Website).count() == 0:
    sites = [
        models.Website(name='Main Website', domain='greensglobal.com', ssl_days=87, uptime=99.98, status='Online'),
        models.Website(name='Client Portal', domain='portal.greensglobal.com', ssl_days=45, uptime=99.92, status='Online'),
        models.Website(name='Blog', domain='blog.greensglobal.com', ssl_days=123, uptime=100, status='Online'),
    ]
    db.add_all(sites)

if db.query(models.ExternalLink).count() == 0:
    links = [
        models.ExternalLink(name='Procore Construction OS', url='https://www.procore.com', category='Operations', description='Primary construction management software for project logs, safety checklists, and plans.', clicks=120),
        models.ExternalLink(name='Sage Intacct Accounting', url='https://www.sage.com', category='Accounting', description='Cloud ERP ledger for budgeting, invoice tracking, and audits.', clicks=85),
        models.ExternalLink(name='Asana Workspace', url='https://asana.com', category='IT', description='Internal tasks tracker, team workload manager, and project scheduling board.', clicks=230),
        models.ExternalLink(name='CoConstruct Portal', url='https://coconstruct.com', category='Operations', description='Custom home building estimating, scheduling, and subcontractor bidding portal.', clicks=64),
        models.ExternalLink(name='Autodesk Build', url='https://construction.autodesk.com', category='Development', description='Design blueprint management, CAD specifications, and zoning docs.', clicks=92),
        models.ExternalLink(name='HubSpot CRM', url='https://www.hubspot.com', category='Marketing', description='Marketing campaign manager, client lead logs, and sales pipeline tracker.', clicks=105),
    ]
    db.add_all(links)

if db.query(models.AccountingTrx).count() == 0:
    trxs = [
        models.AccountingTrx(id='TRX-1234', title='Project Payment - Downtown Complex', date='May 20, 2026', cost=125000),
        models.AccountingTrx(id='TRX-1235', title='Construction Materials', date='May 19, 2026', cost=-45200),
        models.AccountingTrx(id='TRX-1236', title='Contractor Payment', date='May 18, 2026', cost=-67500),
        models.AccountingTrx(id='TRX-1237', title='Property Sale Commission', date='May 17, 2026', cost=89000),
        models.AccountingTrx(id='TRX-1238', title='Office Rent', date='May 16, 2026', cost=-12000),
    ]
    db.add_all(trxs)

if db.query(models.RampTransaction).count() == 0:
    ramps = [
        models.RampTransaction(id='TXN-9031', vendor='Apex Building Supplies', cost=145.00, date='May 22, 2026', category='Office Supplies', memo='OPS Office Supplies & stationary', missing=False),
        models.RampTransaction(id='TXN-9032', vendor='Cemex Ready-Mix', cost=1200.00, date='May 21, 2026', category='Materials', memo='', missing=True),
        models.RampTransaction(id='TXN-9033', vendor='AWS Cloud Billing', cost=452.10, date='May 20, 2026', category='IT Infrastructure', memo='', missing=True),
        models.RampTransaction(id='TXN-9034', vendor='Home Depot', cost=89.50, date='May 19, 2026', category='Tools', memo='Hand tools for Site-B framing crew', missing=False),
        models.RampTransaction(id='TXN-9035', vendor='Adobe Creative Cloud', cost=79.99, date='May 18, 2026', category='Software Licences', memo='', missing=True),
    ]
    db.add_all(ramps)

if db.query(models.AmaEntity).count() == 0:
    amas = [
        models.AmaEntity(entity='Greens Nexus LLC', status='Active', fee_rate=3.5, billed_ytd=142000, next_billing='2026-06-01'),
        models.AmaEntity(entity='GN Construction Con', status='Active', fee_rate=4.0, billed_ytd=98000, next_billing='2026-06-01'),
        models.AmaEntity(entity='Greens Real Estate Dev Ltd', status='Pending Review', fee_rate=3.0, billed_ytd=0, next_billing='TBD'),
        models.AmaEntity(entity='Global Property Management Inc', status='Active', fee_rate=2.5, billed_ytd=45000, next_billing='2026-06-15'),
    ]
    db.add_all(amas)

if db.query(models.OpsProject).count() == 0:
    ops = [
        models.OpsProject(name='Downtown Commercial Complex', status='on-track', location='Main Street, Downtown', members=24, due_date='Aug 15, 2026', progress=75),
        models.OpsProject(name='Residential Tower - Phase 2', status='delayed', location='Harbor View District', members=18, due_date='Sep 30, 2026', progress=45),
        models.OpsProject(name='Industrial Warehouse', status='on-track', location='North Industrial Zone', members=12, due_date='Jun 10, 2026', progress=92),
    ]
    db.add_all(ops)

if db.query(models.DevProject).count() == 0:
    devs = [
        models.DevProject(name='Luxury Apartment Complex', type='Residential • 120 units', status='planning', location='Oceanview District', cost=45, due_date='Q4 2027', roi=18),
        models.DevProject(name='Mixed-Use Development', type='Commercial • 85 units', status='pre-construction', location='Central Business District', cost=68, due_date='Q2 2028', roi=22),
        models.DevProject(name='Suburban Housing Project', type='Residential • 250 units', status='construction', location='Green Valley', cost=32, due_date='Q1 2027', roi=15),
    ]
    db.add_all(devs)

if db.query(models.LmsCourse).count() == 0:
    courses = [
        models.LmsCourse(title='Onsite Safety & Hazard Compliance', category='OPS', duration='2 hours', progress=100, status='Completed'),
        models.LmsCourse(title='Sage Intacct Accounting Basics', category='Accounting', duration='4 hours', progress=40, status='Enrolled'),
        models.LmsCourse(title='GDPR & Corporate IT Security Training', category='IT', duration='1 hour', progress=0, status='Enrolled'),
        models.LmsCourse(title='Construction Blueprint Interpretation', category='Development', duration='3 hours', progress=100, status='Completed'),
        models.LmsCourse(title='HubSpot Lead Routing & Sales Operations', category='Marketing', duration='1.5 hours', progress=85, status='Enrolled'),
    ]
    db.add_all(courses)

db.commit()
db.close()
print("Database seeded successfully.")
