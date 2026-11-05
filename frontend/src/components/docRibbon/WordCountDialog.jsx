// Word's Review > Word Count box, and the Check Accessibility results, both as
// the centered question card (they are read-only answers, not forms).
import { Modal } from '../../tasks/components';

export function WordCountDialog({ stats, pages, onClose }) {
  const rows = [['Pages', pages], ['Words', stats.words], ['Characters (no spaces)', stats.charsNoSpace], ['Characters (with spaces)', stats.chars], ['Paragraphs', stats.paragraphs]];
  return (
    <Modal title="Word Count" onClose={onClose} placement="center" width={360} minHeight="auto"
      footer={<button type="button" className="primary-btn" onClick={onClose}>Close</button>}>
      <table className="doc-wordcount">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.toLocaleString('en-US')}</td></tr>)}</tbody>
      </table>
    </Modal>
  );
}

export function AccessibilityDialog({ issues, onClose }) {
  return (
    <Modal title="Accessibility Checker" onClose={onClose} placement="center" width={440} minHeight="auto"
      footer={<button type="button" className="primary-btn" onClick={onClose}>Close</button>}>
      {issues.length === 0 ? (
        <p style={{ fontSize: 13 }}>No accessibility issues found. People with disabilities should not have difficulty reading this document.</p>
      ) : (
        <ul className="doc-a11y-list">
          {issues.map((it, i) => <li key={i}><strong>Page {it.page}:</strong> {it.text}</li>)}
        </ul>
      )}
    </Modal>
  );
}
