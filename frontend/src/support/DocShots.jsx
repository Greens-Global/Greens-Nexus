// Illustrated "screenshots" for Support -> Documentation.
//
// Deliberately drawn, not captured: a real screenshot is a few hundred KB,
// shows whatever real names/salaries/investors were on screen when it was
// taken, and goes stale the day a button moves. These are simplified wireframes
// of each screen built from the same CSS tokens as the app (so they follow
// light/dark mode) and weigh nothing. Numbered markers sit on the controls
// that matter; each shot's `legend` says what every number is, and
// SupportDocs prints it under the picture. Update the shot when the screen
// it draws changes.
import {
  Bell, Search, LayoutDashboard, Contact, CheckSquare, BookOpen, Package,
  HelpCircle, LogIn, Coffee, ShoppingCart, PenTool, Users, Ticket, Bug,
  Shield, Plus, Star, Sparkles,
} from 'lucide-react';

const BRAND = 'var(--wk-brand, #2b45e1)';
const soft = (c, a = 0.14) => `hsla(var(--color-${c}),${a})`;
const solid = (c) => `hsl(var(--color-${c}))`;
const pill = (c) => ({ fontSize: 9, fontWeight: 700, color: '#fff', background: solid(c), padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' });

// The numbered click marker - sits on the top-right corner of what it marks.
function Mark({ n, children, block, style }) {
  return (
    <span style={{ position: 'relative', display: block ? 'block' : 'inline-flex', ...style }}>
      {children}
      <span style={{
        position: 'absolute', top: -12, right: -15, width: 17, height: 17, borderRadius: '50%',
        background: BRAND, color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex',
        alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 3px var(--card), 0 2px 6px rgba(0,0,0,.25)',
        zIndex: 2, fontFamily: 'Inter, sans-serif',
      }}>{n}</span>
    </span>
  );
}

// A grey text placeholder line.
const Line = ({ w = '100%', h = 7, o = 1 }) => (
  <div style={{ width: w, height: h, borderRadius: 4, background: 'var(--line)', opacity: o, filter: 'brightness(0.92)' }} />
);

function Btn({ children, primary, icon: Icon, color }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
      fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      background: color ? solid(color) : primary ? BRAND : 'var(--card)',
      color: primary || color ? '#fff' : 'var(--ink)',
      border: primary || color ? 'none' : '1px solid var(--line)',
    }}>{Icon && <Icon size={11} />}{children}</span>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 9, padding: 10, ...style }}>
      {children}
    </div>
  );
}

const Tab = ({ children, active }) => (
  <span style={{
    fontSize: 10, fontWeight: 700, padding: '4px 9px', borderRadius: 999, whiteSpace: 'nowrap',
    background: active ? 'var(--ink)' : 'transparent', color: active ? 'var(--card)' : 'var(--muted)',
  }}>{children}</span>
);

const Row = ({ children, gap = 8, style }) => <div style={{ display: 'flex', gap, alignItems: 'center', ...style }}>{children}</div>;
const Col = ({ children, gap = 7, style }) => <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;

function Stat({ label, value, color }) {
  return (
    <Card style={{ flex: 1, minWidth: 0, padding: 8 }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: solid(color), marginTop: 2 }}>{value}</div>
    </Card>
  );
}

// The window chrome: a slim rail, a header with the module's tabs, and a body.
// railMark / tabMark put a numbered marker on the active rail icon / tab
// (markedTab points tabMark at a tab other than the active one).
const RAIL = [LayoutDashboard, Contact, CheckSquare, BookOpen, Package, HelpCircle];
function Frame({ title, tabs = [], active, activeRail, headerMark, railMark, tabMark, markedTab, children }) {
  return (
    <div aria-hidden="true" style={{
      border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--paper)',
      boxShadow: '0 10px 30px rgba(15,23,42,.08)', fontFamily: 'Inter, sans-serif', userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', background: 'var(--card)', borderBottom: '1px solid var(--line)' }}>
        {['#f87171', '#fbbf24', '#34d399'].map((c) => <span key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c, opacity: 0.8 }} />)}
        <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>nexus / {title}</span>
      </div>
      <div style={{ display: 'flex', minHeight: 190 }}>
        <div style={{ width: 34, flexShrink: 0, background: 'var(--card)', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 13, paddingTop: 10 }}>
          <span style={{ width: 18, height: 18, borderRadius: 5, background: 'var(--ink)', color: 'var(--card)', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>N</span>
          {RAIL.map((I, i) => {
            const icon = <I key={i} size={13} style={{ color: i === activeRail ? BRAND : 'var(--muted)', opacity: i === activeRail ? 1 : 0.6 }} />;
            return i === activeRail && railMark ? <Mark key={i} n={railMark}>{icon}</Mark> : icon;
          })}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px 7px 10px', borderBottom: '1px solid var(--line)', background: 'var(--card)' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink)', marginRight: 6, whiteSpace: 'nowrap' }}>{title}</span>
            <div style={{ display: 'flex', gap: 2, flex: 1, minWidth: 0, flexWrap: 'wrap', rowGap: 6 }}>
              {tabs.map((t) => (t === (markedTab || active) && tabMark
                ? <Mark key={t} n={tabMark}><Tab active={t === active}>{t}</Tab></Mark>
                : <Tab key={t} active={t === active}>{t}</Tab>))}
            </div>
            {headerMark}
          </div>
          <div style={{ padding: '14px 16px 14px 12px' }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

// ─── The shots ────────────────────────────────────────────────────────────
// Each shot: `render` draws it, `legend` says what each numbered marker is
// (index 0 = marker 1).
const SHOTS = {
  layout: {
    legend: ['Left menu - moves you between modules', 'Module tabs - the parts of the module you are in', 'Search - or press Ctrl+K anywhere', 'Bell - every alert meant for you'],
    render: () => (
      <Frame title="Dashboard" tabs={['Dashboard', 'Links']} active="Dashboard" activeRail={0} railMark={1} tabMark={2}
        headerMark={<Row gap={22} style={{ marginRight: 8 }}>
          <Mark n={3}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 7px', background: 'var(--mist)', whiteSpace: 'nowrap' }}><Search size={10} /> Ctrl+K</span></Mark>
          <Mark n={4}><Bell size={14} style={{ color: 'var(--ink)' }} /></Mark>
        </Row>}>
        <Col>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>Good morning, Alex</div>
          <Row><Stat label="Open Tasks" value="6" color="blue" /><Stat label="Checked-out Items" value="2" color="orange" /><Stat label="Signatures" value="1" color="green" /></Row>
          <Card><Col gap={6}><Line w="60%" /><Line w="85%" o={0.7} /><Line w="40%" o={0.7} /></Col></Card>
        </Col>
      </Frame>
    ),
  },
  dashboard: {
    legend: ['Greeting and your clock status', 'Stat tiles - click one to open that list', 'Quick Actions - start common jobs in one click', 'Customize - build your own view'],
    render: () => (
      <Frame title="Dashboard" tabs={['Dashboard', 'Links']} active="Dashboard" activeRail={0}
        headerMark={<Mark n={4}><Btn icon={Star}>Customize</Btn></Mark>}>
        <Col gap={10}>
          <Mark n={1} block><div style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)' }}>Good morning, Alex <span style={{ fontSize: 10, color: solid('green'), fontWeight: 700 }}>● Clocked in 8:02 AM</span></div></Mark>
          <Row>
            <Mark n={2} style={{ flex: 1, minWidth: 0 }}><Stat label="Open Tasks" value="6" color="blue" /></Mark>
            <Stat label="Checked-out Items" value="2" color="orange" />
            <Stat label="My Equipment" value="3" color="purple" />
          </Row>
          <Row style={{ alignItems: 'stretch' }}>
            <Card style={{ flex: 2 }}><Col gap={6}><Line w="50%" /><Line o={0.7} /><Line w="80%" o={0.7} /></Col></Card>
            <Mark n={3} style={{ flex: 1, minWidth: 0 }}><Card style={{ width: '100%' }}><Col gap={5}><Btn icon={Plus}>New Task</Btn><Btn icon={Package}>Request Item</Btn></Col></Card></Mark>
          </Row>
        </Col>
      </Frame>
    ),
  },
  clock: {
    legend: ['Clock tab', 'Punch In (becomes Punch Out once you are in)', 'Start Break / End Break', 'Where the punch was recorded'],
    render: () => (
      <Frame title="Workday" tabs={['Overview', 'Clock', 'Time Sheet', 'Shifts', 'Time Off']} active="Clock" activeRail={1} tabMark={1}>
        <Row style={{ alignItems: 'stretch' }}>
          <Card style={{ flex: 1.2 }}>
            <Col gap={9} style={{ alignItems: 'center', padding: '4px 0' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>9:41 AM</div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>Not clocked in</div>
              <Row gap={14}>
                <Mark n={2}><Btn primary icon={LogIn}>Punch In</Btn></Mark>
                <Mark n={3}><Btn color="orange" icon={Coffee}>Start Break</Btn></Mark>
              </Row>
              <Mark n={4}><span style={{ fontSize: 9.5, color: solid('green'), background: soft('green'), padding: '2px 8px', borderRadius: 999, fontWeight: 700 }}>On Site - Escondido</span></Mark>
            </Col>
          </Card>
          <Card style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--ink)', marginBottom: 7 }}>This Pay Period</div>
            <Col gap={6}>{[80, 65, 90, 40].map((w, i) => <Row key={i} gap={6}><Line w="30%" /><div style={{ height: 7, width: `${w * 0.6}%`, borderRadius: 4, background: soft('blue', 0.5) }} /></Row>)}</Col>
          </Card>
        </Row>
      </Frame>
    ),
  },
  tasks: {
    legend: ['My Tasks tab - everything assigned to you', 'One-line box - type a task name', 'Press Enter to add it', 'Create - the full task form'],
    render: () => (
      <Frame title="Tasks" tabs={['Home', 'My Tasks', 'Projects', 'Portfolios', 'Teams']} active="My Tasks" activeRail={2} tabMark={1}
        headerMark={<Mark n={4}><Btn primary icon={Plus}>Create</Btn></Mark>}>
        <Col gap={0}>
          <Mark n={2} block style={{ marginBottom: 8 }}>
            <div style={{ border: `1.5px dashed ${BRAND}`, borderRadius: 7, padding: '6px 9px', fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>+ Write a task name</span>
              <Mark n={3} style={{ marginRight: 16 }}><kbd style={{ fontSize: 9, border: '1px solid var(--line)', borderRadius: 4, padding: '0 4px', background: 'var(--mist)' }}>Enter</kbd></Mark>
            </div>
          </Mark>
          {[['Replace the pump seal', 'In Progress', 'blue'], ['Unit 12 turnover checklist', 'Not Started', 'orange'], ['Submit Q3 vendor list', 'Done', 'green']].map(([t, st, c]) => (
            <Row key={t} style={{ padding: '6px 4px', borderBottom: '1px solid var(--line)' }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, border: '1.5px solid var(--muted)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--ink)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
              <span style={pill(c)}>{st}</span>
            </Row>
          ))}
        </Col>
      </Frame>
    ),
  },
  tickets: {
    legend: ['Unassigned tile - filters to tickets nobody owns yet', 'Click a row to open the full thread', 'Change the state right from the list'],
    render: () => (
      <Frame title="Tickets" tabs={['All', 'My Requests', 'Assigned to Me']} active="All" activeRail={-1}
        headerMark={<Btn primary icon={Plus}>Create</Btn>}>
        <Col gap={10}>
          <Row gap={6}>
            <Stat label="Open" value="14" color="blue" />
            <Mark n={1} style={{ flex: 1, minWidth: 0 }}><Stat label="Unassigned" value="3" color="orange" /></Mark>
            <Stat label="SLA Breached" value="1" color="red" />
            <Stat label="Resolved" value="9" color="green" />
          </Row>
          <Card style={{ padding: 0 }}>
            <Row style={{ padding: '8px 16px 8px 9px', borderBottom: '1px solid var(--line)' }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--ink)', width: 50, flexShrink: 0 }}>#000231</span>
              <Mark n={2} style={{ flex: 1, minWidth: 0 }}><span style={{ fontSize: 10.5, color: 'var(--ink)', whiteSpace: 'nowrap' }}>Laptop will not charge</span></Mark>
              <Mark n={3}><span style={pill('blue')}>New</span></Mark>
            </Row>
            <Row style={{ padding: '8px 16px 8px 9px' }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--ink)', width: 50, flexShrink: 0 }}>#000230</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Access to Sage Intacct</span>
              <span style={pill('purple')}>In Progress</span>
            </Row>
          </Card>
        </Col>
      </Frame>
    ),
  },
  kb: {
    legend: ['Playbook tab - the whole library', 'Search box - filters as you type (or press /)', 'Ask AI - answers from approved SOPs, with sources', 'Verified or Needs Verification - is it current?'],
    render: () => (
      <Frame title="Knowledge Base" tabs={['Playbook', 'Learn']} active="Playbook" activeRail={3} tabMark={1}>
        <Col gap={9}>
          <Row gap={14}>
            <Mark n={2} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 9, padding: '8px 10px', background: 'var(--card)', fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                <Search size={12} /> How do I process a move-out?
              </div>
            </Mark>
            <Mark n={3}><Btn primary icon={Sparkles}>Ask AI</Btn></Mark>
          </Row>
          {[['Move-Out Inspection SOP', true], ['Gate Code Reset Procedure', true], ['Lock Cut Policy', false]].map(([t, ok], i) => {
            const chip = <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: soft(ok ? 'green' : 'orange'), color: solid(ok ? 'green' : 'orange'), whiteSpace: 'nowrap' }}>{ok ? 'Verified' : 'Needs Verification'}</span>;
            return (
              <Card key={t} style={{ padding: '7px 16px 7px 10px' }}>
                <Row>
                  <BookOpen size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
                  {i === 0 ? <Mark n={4}>{chip}</Mark> : chip}
                </Row>
              </Card>
            );
          })}
        </Col>
      </Frame>
    ),
  },
  sign: {
    legend: ['Nexus Sign tab', 'Drop in the PDF or Word file (or start from a template)', 'Add each signer\'s name and email', 'Drag fields like Signature onto the page', 'Send - signers get an email link'],
    render: () => (
      <Frame title="Documents" tabs={['Dashboard', 'My Documents', 'Templates', 'Nexus Sign']} active="Nexus Sign" activeRail={-1} tabMark={1}>
        <Row style={{ alignItems: 'stretch' }} gap={14}>
          <Col style={{ flex: 1, minWidth: 0 }} gap={12}>
            <Mark n={2} block>
              <div style={{ border: '1.5px dashed var(--muted)', borderRadius: 9, padding: '14px 8px', textAlign: 'center', fontSize: 10, color: 'var(--muted)' }}>Drop a PDF or Word file here</div>
            </Mark>
            <Mark n={3} block>
              <Card style={{ padding: 8 }}><Row gap={6}><Users size={11} style={{ color: 'var(--muted)' }} /><Col gap={4} style={{ flex: 1 }}><Line w="70%" /><Line w="55%" o={0.7} /></Col></Row></Card>
            </Mark>
          </Col>
          <Card style={{ flex: 1.2, minWidth: 0 }}>
            <Col gap={6}><Line /><Line w="90%" o={0.7} /><Line w="75%" o={0.7} /><Line w="85%" o={0.7} /></Col>
            <div style={{ marginTop: 14 }}>
              <Mark n={4}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700, color: BRAND, border: `1.5px solid ${BRAND}`, borderRadius: 5, padding: '4px 10px', background: 'var(--mist)' }}><PenTool size={10} /> Signature</span>
              </Mark>
            </div>
          </Card>
        </Row>
        <Row style={{ justifyContent: 'flex-end', marginTop: 12 }}><Mark n={5}><Btn primary>Send</Btn></Mark></Row>
      </Frame>
    ),
  },
  items: {
    legend: ['Browse Catalog - everything you can borrow', 'Add to Cart', 'Cart - give a reason and dates, then submit', 'After handover, click Confirm Receipt'],
    render: () => (
      <Frame title="Item Management" tabs={['Browse Catalog', 'My Checkouts']} active="Browse Catalog" activeRail={4} tabMark={1}
        headerMark={<Mark n={3}><Btn color="green" icon={ShoppingCart}>Cart 1</Btn></Mark>}>
        <Row style={{ alignItems: 'stretch' }} gap={10}>
          {[['Dell Latitude 5440', 'Available'], ['DeWalt Drill Kit', 'Available'], ['Ford F-150 #3', 'Checked Out']].map(([t, st], i) => (
            <Card key={t} style={{ flex: 1, minWidth: 0, padding: 8 }}>
              <div style={{ height: 38, borderRadius: 6, background: 'var(--mist)', border: '1px solid var(--line)', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Package size={16} style={{ color: 'var(--muted)' }} /></div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
              <div style={{ fontSize: 9, color: st === 'Available' ? solid('green') : 'var(--muted)', fontWeight: 700, margin: '2px 0 6px' }}>{st}</div>
              {i === 0 ? <Mark n={2}><Btn primary>Add to Cart</Btn></Mark> : <Btn>{st === 'Available' ? 'Add to Cart' : 'Unavailable'}</Btn>}
            </Card>
          ))}
        </Row>
        <Row style={{ marginTop: 14 }}><Mark n={4}><span style={{ fontSize: 9.5, fontWeight: 700, color: solid('blue'), background: soft('blue'), padding: '3px 9px', borderRadius: 999 }}>Awaiting Handover - Confirm Receipt</span></Mark></Row>
      </Frame>
    ),
  },
  people: {
    legend: ['People tab - the employee directory', 'Add Person', 'Fill in their details and manager', 'Choose a Job Role - it decides their Nexus access'],
    render: () => (
      <Frame title="People" tabs={['People', 'Hiring', 'Org Chart', 'Leave', 'Time']} active="People" activeRail={-1} tabMark={1}
        headerMark={<Mark n={2}><Btn primary icon={Plus}>Add Person</Btn></Mark>}>
        <Row style={{ alignItems: 'stretch' }} gap={12}>
          <Card style={{ flex: 1, minWidth: 0, padding: 0 }}>
            {['Jordan Lee', 'Sam Patel', 'Riley Chen'].map((n, i) => (
              <Row key={n} style={{ padding: '7px 9px', borderBottom: i < 2 ? '1px solid var(--line)' : 'none' }}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', background: soft(['blue', 'green', 'purple'][i], 0.3), flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{n}</span>
              </Row>
            ))}
          </Card>
          <Card style={{ flex: 1, minWidth: 0 }}>
            <Col gap={10}>
              <Mark n={3} block><Col gap={5}><Line w="45%" /><div style={{ height: 16, borderRadius: 5, border: '1px solid var(--line)' }} /><Line w="35%" /><div style={{ height: 16, borderRadius: 5, border: '1px solid var(--line)' }} /></Col></Mark>
              <Mark n={4} block><div style={{ height: 20, borderRadius: 5, border: `1.5px solid ${BRAND}`, fontSize: 9.5, color: BRAND, fontWeight: 700, display: 'flex', alignItems: 'center', padding: '0 7px', whiteSpace: 'nowrap' }}>Choose a Job Role</div></Mark>
            </Col>
          </Card>
        </Row>
      </Frame>
    ),
  },
  support: {
    legend: ['Submit a Ticket - help from any team', 'My Open Tickets - click a row to follow up', 'Documentation tab - this guide'],
    render: () => (
      <Frame title="Support" tabs={['Help Center', 'Documentation']} active="Help Center" activeRail={5} tabMark={3} markedTab="Documentation">
        <Row style={{ alignItems: 'stretch' }} gap={10}>
          {[[Ticket, 'Submit a Ticket'], [Bug, 'Report a Bug'], [Users, 'Contact Directory'], [Shield, 'Privacy Policy']].map(([I, t], i) => {
            const card = (
              <Card style={{ padding: 8, width: '100%', boxSizing: 'border-box' }}>
                <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--mist)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}><I size={12} style={{ color: 'var(--ink)' }} /></span>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
                <div style={{ marginTop: 5 }}><Line w="85%" o={0.6} /></div>
              </Card>
            );
            return i === 0
              ? <Mark key={t} n={1} style={{ flex: 1, minWidth: 0 }}>{card}</Mark>
              : <div key={t} style={{ flex: 1, minWidth: 0, display: 'flex' }}>{card}</div>;
          })}
        </Row>
        <Mark n={2} block style={{ marginTop: 14 }}>
          <Card style={{ padding: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>My Open Tickets</div>
            <Row><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--ink)' }}>#000231</span><span style={{ flex: 1, fontSize: 10, color: 'var(--ink)' }}>Laptop will not charge</span><span style={pill('blue')}>New</span></Row>
          </Card>
        </Mark>
      </Frame>
    ),
  },
  access: {
    legend: ['Global Settings > Access', 'Pick the person', 'Their job role - the baseline set of modules', 'Access level for a module: Viewer, Editor, Full or Owner'],
    render: () => (
      <Frame title="Settings" tabs={['Global Settings', 'Company Settings', 'Tools', 'Audit Logs']} active="Global Settings" activeRail={-1} tabMark={1}>
        <Row style={{ alignItems: 'stretch' }} gap={14}>
          <Mark n={2} style={{ flex: 0.8, minWidth: 0 }}>
            <Card style={{ width: '100%', padding: 0 }}>
              {['Jordan Lee', 'Sam Patel', 'Riley Chen'].map((n, i) => (
                <div key={n} style={{ padding: '7px 9px', fontSize: 10.5, fontWeight: 600, color: 'var(--ink)', background: i === 0 ? 'var(--mist)' : 'transparent', borderBottom: i < 2 ? '1px solid var(--line)' : 'none', whiteSpace: 'nowrap' }}>{n}</div>
              ))}
            </Card>
          </Mark>
          <Card style={{ flex: 1.3, minWidth: 0 }}>
            <Col gap={11}>
              <Mark n={3} block><Row><span style={{ fontSize: 10, color: 'var(--muted)', width: 54 }}>Job role</span><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 5, padding: '3px 8px', whiteSpace: 'nowrap' }}>Site Manager</span></Row></Mark>
              <Row><span style={{ fontSize: 10, color: 'var(--muted)', width: 54 }}>Groups</span><span style={{ fontSize: 9.5, fontWeight: 700, color: solid('purple'), background: soft('purple'), padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>+ Accounting</span></Row>
              <Mark n={4} block>
                <Row gap={4} style={{ flexWrap: 'wrap' }}>{['Viewer', 'Editor', 'Full', 'Owner'].map((l) => (
                  <span key={l} style={{ fontSize: 9.5, fontWeight: 700, padding: '3px 8px', borderRadius: 5, background: l === 'Editor' ? 'var(--ink)' : 'transparent', color: l === 'Editor' ? 'var(--card)' : 'var(--muted)', border: '1px solid var(--line)' }}>{l}</span>
                ))}</Row>
              </Mark>
            </Col>
          </Card>
        </Row>
      </Frame>
    ),
  },
};

// eslint-disable-next-line react-refresh/only-export-components
export const shotLegend = (key) => SHOTS[key]?.legend || [];

export default function DocShot({ shot }) {
  const Shot = SHOTS[shot]?.render;
  return Shot ? <Shot /> : null;
}
