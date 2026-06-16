import { useState } from 'react';
import { Megaphone, Star, Eye, MousePointerClick, ShoppingCart, DollarSign, TrendingUp, Target, BarChart2, Calendar, Download, Sparkles, Check } from 'lucide-react';

const CAMPAIGNS = [
  { name: 'Harbor View - Search Ads', property: 'Harbor View', platform: 'Google Search', impressions: 45230, clicks: 1420, conversions: 68, abandonedCarts: 112, spend: 1250, status: 'Active' },
  { name: 'Downtown Complex - Display', property: 'Downtown Complex', platform: 'Google Display', impressions: 32100, clicks: 890, conversions: 42, abandonedCarts: 87, spend: 980, status: 'Active' },
  { name: 'Residential Towers - Remarketing', property: 'Residential Towers', platform: 'Google Remarketing', impressions: 18400, clicks: 620, conversions: 31, abandonedCarts: 55, spend: 640, status: 'Active' },
  { name: 'Commercial Spaces - Shopping', property: 'Commercial Spaces', platform: 'Google Shopping', impressions: 28900, clicks: 1140, conversions: 55, abandonedCarts: 93, spend: 890, status: 'Active' },
  { name: 'Luxury Condos - YouTube', property: 'Luxury Condos', platform: 'YouTube Ads', impressions: 61200, clicks: 1820, conversions: 48, abandonedCarts: 142, spend: 1440, status: 'Paused' },
];

const REVIEWS = [
  { id: 1, name: 'John Smith', property: 'Harbor View Condos', platform: 'Google', date: '2 hours ago', rating: 5, comment: 'Absolutely stunning property! The construction quality exceeded our expectations. The team was professional throughout the entire process.', replied: false, badge: 'New Review', badgeColor: 'red', aiReply: "Thank you so much for your wonderful review, John! We're thrilled that the Harbor View Condos exceeded your expectations. Our team works incredibly hard to deliver the highest quality construction, and your feedback means the world to us. We hope you enjoy your new home!" },
  { id: 2, name: 'Jane Doe', property: 'Downtown Complex', platform: 'Google', date: '1 day ago', rating: 4, comment: 'Great commercial space with excellent amenities. Minor delays during construction but overall very satisfied.', replied: false, badge: 'AI Reply Suggested', badgeColor: 'blue', aiReply: "Hi Jane, thank you for sharing your experience with Downtown Complex! We appreciate your patience during the construction phase and are glad you are overall satisfied with the space. Your feedback about the delays helps us improve our project management processes." },
  { id: 3, name: 'Marcus Brody', property: 'Downtown Commercial Complex', platform: 'Google', date: '3 days ago', rating: 3, comment: 'Decent location and layout but communication during the project could be improved.', replied: false, badge: null, badgeColor: null, aiReply: null },
  { id: 4, name: 'Linda Chavez', property: 'Harbor View Condos', platform: 'Google', date: '1 week ago', rating: 5, comment: 'Perfect in every way. Love the finishings.', replied: true, replyText: 'Thank you Linda! We are so happy you are enjoying your home. Please do not hesitate to reach out if you need anything.' },
  { id: 5, name: 'Robert Nguyen', property: 'Oakridge Subdivision', platform: 'Google', date: '2 weeks ago', rating: 4, comment: 'Great community development. Infrastructure is solid.', replied: true, replyText: 'Thank you Robert! The Oakridge community is very special to us and we are glad you feel it too.' },
];

const PROPERTY_OPTIONS = ['All Properties', 'Harbor View', 'Downtown Complex', 'Oakridge', 'Residential Towers', 'Luxury Condos', 'Commercial Spaces'];

export default function Marketing({ activeSub, onSubChange }) {
  const sub = activeSub || 'marketing-ads';
  const [propertyFilter, setPropertyFilter] = useState('All Properties');
  const [reviews, setReviews] = useState(REVIEWS);
  const [expandedAI, setExpandedAI] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});

  const filteredCampaigns = propertyFilter === 'All Properties' ? CAMPAIGNS : CAMPAIGNS.filter(c => c.property.toLowerCase().includes(propertyFilter.toLowerCase()) || propertyFilter.toLowerCase().includes(c.property.toLowerCase()));
  const filteredReviews = propertyFilter === 'All Properties' ? reviews : reviews.filter(r => r.property && (r.property.toLowerCase().includes(propertyFilter.toLowerCase()) || propertyFilter.toLowerCase().includes(r.property.toLowerCase())));

  const impressions = filteredCampaigns.reduce((s, c) => s + c.impressions, 0);
  const clicks = filteredCampaigns.reduce((s, c) => s + c.clicks, 0);
  const conversions = filteredCampaigns.reduce((s, c) => s + c.conversions, 0);
  const abandonedCarts = filteredCampaigns.reduce((s, c) => s + c.abandonedCarts, 0);
  const spend = filteredCampaigns.reduce((s, c) => s + c.spend, 0);
  const cpc = clicks > 0 ? (spend / clicks).toFixed(2) : 0;
  const convRate = clicks > 0 ? ((conversions / clicks) * 100).toFixed(1) : 0;
  const costPerConv = conversions > 0 ? (spend / conversions).toFixed(2) : 0;

  const notReplied = reviews.filter(r => !r.replied).length;

  const applyAiReply = (id) => {
    const review = reviews.find(r => r.id === id);
    if (review?.aiReply) setReplyDrafts(p => ({ ...p, [id]: review.aiReply }));
    setExpandedAI(id);
  };

  const postReply = (id) => {
    const text = replyDrafts[id];
    if (!text?.trim()) return;
    setReviews(prev => prev.map(r => r.id === id ? { ...r, replied: true, replyText: text } : r));
    setExpandedAI(null);
  };

  const stars = (n) => Array.from({ length: 5 }, (_, i) => (
    <Star key={i} size={14} fill={i < n ? 'hsl(var(--color-gold))' : 'none'} style={{ color: 'hsl(var(--color-gold))' }} />
  ));

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Top Bar: Tabs + Filter */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 20, borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {[{ key: 'marketing-ads', label: 'Google Ads Performance', Icon: Megaphone }, { key: 'marketing-reputation', label: 'Reputation Management', Icon: Star }].map(({ key, label, Icon }) => (
            <button key={key} onClick={() => onSubChange(key)}
              style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon size={18} /> {label}
              {sub === key && <span style={{ position: 'absolute', bottom: -17, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Property Filter:</label>
          <select className="form-select" value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} style={{ padding: '6px 12px', fontSize: '0.85rem', width: 200 }}>
            {PROPERTY_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
      </div>

      {/* Google Ads */}
      {sub === 'marketing-ads' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Google Ads Performance Metrics</h2>
              <p>Google Ads campaigns analysis, spend telemetry, and conversion analytics</p>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Calendar size={16} /> Date Range</button>
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Download size={16} /> Export</button>
            </div>
          </div>

          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Impressions', value: impressions.toLocaleString(), helper: 'Live impressions synced', color: 'card-blue', Icon: Eye },
              { label: 'Clicks', value: clicks.toLocaleString(), helper: 'CPC traffic load', color: 'card-green', Icon: MousePointerClick },
              { label: 'Conversions', value: conversions.toLocaleString(), helper: `Conv. Rate: ${convRate}%`, color: 'card-green', Icon: Target },
              { label: 'Abandoned Carts', value: abandonedCarts.toLocaleString(), helper: 'Retargetable leads', color: 'card-red', Icon: ShoppingCart },
              { label: 'Ad Spend', value: `$${spend.toLocaleString()}`, helper: 'Total budget consumed', color: 'card-blue', Icon: DollarSign },
              { label: 'Cost Per Click', value: `$${cpc}`, helper: 'Average CPC rate', color: 'card-blue', Icon: TrendingUp },
              { label: 'Cost Per Conv.', value: `$${costPerConv}`, helper: 'Revenue per conversion', color: 'card-green', Icon: BarChart2 },
              { label: 'Active Campaigns', value: filteredCampaigns.filter(c => c.status === 'Active').length, helper: `${filteredCampaigns.length} total campaigns`, color: 'card-purple', Icon: Megaphone },
            ].map(({ label, value, helper, color, Icon }) => (
              <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
                <div className="kpi-card-header">
                  <span className="kpi-title">{label}</span>
                  <div className="kpi-icon-container"><Icon size={18} /></div>
                </div>
                <div className="kpi-stat" style={{ fontSize: '1.8rem' }}>{value}</div>
                <div className="kpi-helper">{helper}</div>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Active Campaign Performance</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Real-time stats from Google Ads API integration</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Campaign</th><th>Platform</th><th>Impressions</th><th>Clicks</th><th>Conversions</th><th>Abandoned Carts</th><th>Spend</th><th>Status</th></tr></thead>
                <tbody>
                  {filteredCampaigns.map(c => (
                    <tr key={c.name}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td data-th="Platform" style={{ color: 'var(--text-secondary)' }}>{c.platform}</td>
                      <td data-th="Impressions">{c.impressions.toLocaleString()}</td>
                      <td data-th="Clicks">{c.clicks.toLocaleString()}</td>
                      <td data-th="Conversions" style={{ fontWeight: 600, color: 'hsl(var(--color-green))' }}>{c.conversions}</td>
                      <td data-th="Abandoned carts" style={{ fontWeight: 600, color: 'hsl(var(--color-orange))' }}>{c.abandonedCarts}</td>
                      <td data-th="Spend" style={{ fontWeight: 700 }}>${c.spend.toLocaleString()}</td>
                      <td data-th="Status">
                        <span style={{ backgroundColor: c.status === 'Active' ? '#111827' : 'var(--bg-secondary)', color: c.status === 'Active' ? '#fff' : 'var(--text-secondary)', border: c.status !== 'Active' ? '1px solid var(--border-color)' : 'none', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700 }}>{c.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {[
              { label: 'Top Campaign', value: filteredCampaigns.sort((a, b) => b.conversions - a.conversions)[0]?.name || '—', sub: 'Highest conversions' },
              { label: 'Avg. CTR', value: clicks > 0 ? ((clicks / impressions) * 100).toFixed(2) + '%' : '0%', sub: 'Click-through rate' },
              { label: 'Total ROAS', value: spend > 0 ? (conversions * 850 / spend).toFixed(1) + 'x' : '—', sub: 'Return on ad spend (est.)' },
            ].map(({ label, value, sub: s }) => (
              <div key={label} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)' }}>
                <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 16 }}>{label}</h4>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: 4 }}>{value}</div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{s}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Reputation Management */}
      {sub === 'marketing-reputation' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Reputation Management</h2>
              <p>Google Reviews monitoring, AI reply suggestions, and response tracking</p>
            </div>
          </div>

          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
            {[
              { label: 'Total Reviews', value: reviews.length, helper: 'All platforms', color: 'card-blue' },
              { label: 'Avg. Rating', value: (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) + ' ★', helper: 'Overall score', color: 'card-gold' },
              { label: 'Pending Reply', value: notReplied, helper: 'Need response', color: 'card-red' },
              { label: 'Replied', value: reviews.length - notReplied, helper: 'Responses sent', color: 'card-green' },
            ].map(({ label, value, helper, color }) => (
              <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
                <div className="kpi-card-header"><span className="kpi-title">{label}</span></div>
                <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
                <div className="kpi-helper">{helper}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            {['All', 'Not Replied', 'Replied'].map(f => (
              <button key={f} style={{ borderRadius: 20, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)', padding: '6px 14px', fontWeight: 600, cursor: 'pointer', fontSize: '0.825rem' }}>{f}</button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {filteredReviews.map(r => (
              <div key={r.id} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      {r.name.charAt(0)}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{r.name}</strong>
                        <span style={{ fontSize: '0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-secondary)', fontWeight: 500 }}>{r.platform}</span>
                        <span style={{ fontSize: '0.75rem', backgroundColor: 'hsla(var(--color-blue), 0.05)', border: '1px solid hsla(var(--color-blue), 0.15)', padding: '2px 6px', borderRadius: 4, color: 'hsl(var(--color-blue))', fontWeight: 500 }}>{r.property}</span>
                      </div>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{r.date}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 2 }}>{stars(r.rating)}</div>
                    {r.badge && (
                      <span style={{ backgroundColor: r.badgeColor === 'red' ? 'hsla(var(--color-red), 0.1)' : 'var(--bg-secondary)', color: r.badgeColor === 'red' ? 'hsl(var(--color-red))' : 'var(--text-secondary)', border: r.badgeColor !== 'red' ? '1px solid var(--border-color)' : 'none', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                        {r.badge}
                      </span>
                    )}
                    {r.replied && !r.badge && (
                      <span style={{ backgroundColor: 'hsla(var(--color-green), 0.1)', color: 'hsl(var(--color-green))', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase' }}>Replied</span>
                    )}
                  </div>
                </div>

                <p style={{ fontSize: '0.925rem', color: 'var(--text-primary)', lineHeight: 1.6, marginBottom: 16 }}>{r.comment}</p>

                {r.replied && r.replyText && (
                  <div style={{ backgroundColor: 'hsla(var(--color-green), 0.03)', borderLeft: '3px solid hsl(var(--color-green))', borderRadius: '0 8px 8px 0', padding: '12px 16px' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'hsl(var(--color-green))', marginBottom: 4, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Business Owner Response</div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r.replyText}</div>
                  </div>
                )}

                {!r.replied && (
                  <div>
                    {r.aiReply && expandedAI !== r.id && (
                      <button onClick={() => applyAiReply(r.id)}
                        style={{ background: 'none', border: '1px solid hsla(var(--color-blue), 0.25)', color: 'hsl(var(--color-blue))', padding: '6px 12px', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Sparkles size={14} /> Use AI Suggested Reply
                      </button>
                    )}
                    {expandedAI === r.id && (
                      <div style={{ backgroundColor: 'hsla(var(--color-blue), 0.04)', border: '1px solid hsla(var(--color-blue), 0.15)', borderRadius: 8, padding: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: '0.85rem', color: 'hsl(var(--color-blue))', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          <Sparkles size={14} /> AI Suggested Reply
                        </div>
                        <textarea
                          style={{ width: '100%', minHeight: 100, border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, fontSize: '0.9rem', fontFamily: 'inherit', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', resize: 'vertical', outline: 'none', marginBottom: 12, boxSizing: 'border-box' }}
                          value={replyDrafts[r.id] || r.aiReply}
                          onChange={e => setReplyDrafts(p => ({ ...p, [r.id]: e.target.value }))}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="primary-btn" onClick={() => postReply(r.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
                            <Check size={14} /> Post Reply
                          </button>
                          <button className="secondary-btn" onClick={() => setExpandedAI(null)} style={{ fontSize: '0.85rem' }}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
