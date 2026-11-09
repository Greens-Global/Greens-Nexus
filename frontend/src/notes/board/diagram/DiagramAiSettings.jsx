// Settings > Notes & Boards > Diagram From a Sentence (Neil, 11/08/2026).
// One switch, saved on click. It cannot be turned on while AI is off for
// Nexus (the server says `aiAvailable: false`, and its PUT refuses true with
// a 409 anyway) - Neil: "cannot be toggled on until a super administrator
// such as Visesh or Neil enables it and connects an AI API".
import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { SwitchRow } from '../../../components/settings/SettingsUI';
import { SkeletonBlocks } from '../../../components/AsyncState';

/** Why From a Sentence is off - the same words the server answers with. */
export const AI_OFF_NOTE = 'Turned off. A Super Administrator (Neil or Visesh) must enable AI for Nexus and connect an AI service first.';

export default function DiagramAiSettings({ toastOk, toastErr }) {
  const [cfg, setCfg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let on = true;
    api.getDiagramAiSettings()
      .then((r) => { if (on) setCfg(r || { diagramAiEnabled: false, aiAvailable: false }); })
      .catch((e) => { if (on) setLoadErr(e?.message || 'This setting did not load. Try again in a moment.'); });
    return () => { on = false; };
  }, []);
  if (loadErr) return <p role="alert" className="nx-set-row-desc">{loadErr}</p>;
  if (!cfg) return <SkeletonBlocks count={1} height={56} borderRadius={10} />;
  const off = !cfg.aiAvailable;
  const flip = (next) => {
    if (off && next) return;   // never asked while AI is off (the server would refuse it too)
    setSaving(true);
    api.setDiagramAiSettings(next)
      .then((r) => { setCfg(r); toastOk?.(next ? 'Diagram From a Sentence is on.' : 'Diagram From a Sentence is off.'); })
      .catch((e) => toastErr?.(e?.detail || e?.message || 'Could not save.'))
      .finally(() => setSaving(false));
  };
  return (
    <SwitchRow id="diagram-ai" title="Diagram From a Sentence" checked={!!cfg.diagramAiEnabled} disabled={off || saving} onChange={flip}
      desc={off ? AI_OFF_NOTE : 'On a board, people may describe a diagram in a sentence and Nexus writes it as text for them to check before anything is placed.'} />
  );
}
