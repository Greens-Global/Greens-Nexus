// Asset "Media" card: a collapsible section showing an asset's photo(s), with an inline edit
// mode for uploading/removing pictures, and a fullscreen click-to-zoom lightbox.
//
// Supports the legacy single `image` field as well as the newer `images` array — reads whichever
// is present, always writes back through `images` via onSave.

import { useState } from 'react';
import { ChevronDown, Upload, X } from 'lucide-react';
import { Card } from '../shared/Card.jsx';
import { resizeImageToDataUrl } from '../../lib/format.js';

const THUMB_STYLE = {
  width: 132,
  height: 96,
  objectFit: 'cover',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  display: 'block',
};

/**
 * @param p        the asset record (reads p.images / p.image, p.name)
 * @param n        badge number shown next to the "Media" title (e.g. section index), or null to omit
 * @param onSave   (images: string[]) => void — called with the full new image list on Save
 */
export function PhotoGallery({ p, n, onSave }) {
  const currentImages = p.images && p.images.length ? p.images : p.image ? [p.image] : [];
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draftImages, setDraftImages] = useState([]);
  const [lightbox, setLightbox] = useState(null);

  const startEdit = (e) => {
    e.stopPropagation();
    setDraftImages(currentImages);
    setEditing(true);
    setExpanded(true);
  };

  const addFiles = async (files) => {
    const resized = [];
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        try {
          resized.push(await resizeImageToDataUrl(file));
        } catch {
          // unreadable/corrupt image — skip it
        }
      }
    }
    setDraftImages((prev) => [...prev, ...resized]);
  };

  const handleUpload = async (e) => {
    await addFiles([...(e.target.files || [])]);
    e.target.value = '';
  };

  const handlePaste = (e) => {
    const list = e.clipboardData?.items || [];
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          addFiles([blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' })]);
          return;
        }
      }
    }
  };

  const images = editing ? draftImages : currentImages;

  return (
    <Card>
      <div
        onClick={() => !editing && setExpanded((v) => !v)}
        title={editing ? '' : expanded ? 'Collapse' : 'Expand'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          cursor: editing ? 'default' : 'pointer',
          userSelect: 'none',
          marginBottom: expanded ? 14 : 0,
          paddingBottom: expanded ? 10 : 0,
          borderBottom: expanded ? '1px solid var(--border-color)' : 'none',
        }}
      >
        {n != null && (
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#fff',
              backgroundColor: 'var(--pine)',
            }}
          >
            {n}
          </span>
        )}
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Media {images.length > 0 && `(${images.length})`}
        </strong>
        {expanded && !editing && (
          <button
            className="secondary-btn"
            onClick={startEdit}
            style={{
              marginLeft: 'auto',
              padding: '4px 12px',
              fontSize: '0.76rem',
              color: 'hsl(var(--color-blue))',
              borderColor: 'hsl(var(--color-blue))',
              backgroundColor: 'hsl(var(--color-blue) / 0.08)',
            }}
          >
            Edit
          </button>
        )}
        <ChevronDown
          size={18}
          style={{
            marginLeft: expanded && !editing ? 8 : 'auto',
            color: 'var(--text-secondary)',
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        />
      </div>

      {expanded && (
        <>
          {images.length === 1 ? (
            <div style={{ position: 'relative', maxWidth: 480 }}>
              <img
                src={images[0]}
                alt={p.name}
                loading="lazy"
                onClick={() => !editing && setLightbox(images[0])}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                style={{
                  width: '100%',
                  height: 280,
                  objectFit: 'cover',
                  borderRadius: 10,
                  border: '1px solid var(--border-color)',
                  display: 'block',
                  cursor: editing ? 'default' : 'zoom-in',
                }}
              />
              {editing && (
                <button
                  onClick={() => setDraftImages([])}
                  title="Remove"
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#fff',
                    backgroundColor: 'hsl(var(--color-red))',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ) : images.length > 1 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {images.map((src, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <img
                    src={src}
                    alt={`${p.name} ${i + 1}`}
                    loading="lazy"
                    onClick={() => !editing && setLightbox(src)}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    style={{ ...THUMB_STYLE, cursor: editing ? 'default' : 'zoom-in' }}
                  />
                  {editing && (
                    <button
                      onClick={() => setDraftImages((imgs) => imgs.filter((_, idx) => idx !== i))}
                      title="Remove"
                      style={{
                        position: 'absolute',
                        top: -7,
                        right: -7,
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#fff',
                        backgroundColor: 'hsl(var(--color-red))',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                height: 120,
                borderRadius: 10,
                border: '1px dashed var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                fontSize: '0.82rem',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              {editing ? 'Upload pictures below.' : 'No pictures — click Edit to add.'}
            </div>
          )}

          {editing && (
            <div onPaste={handlePaste} tabIndex={0} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap', outline: 'none' }}>
              <label className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <Upload size={14} /> Upload pictures
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleUpload} />
              </label>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>or press Ctrl+V to paste a screenshot</span>
              <button
                className="secondary-btn"
                onClick={() => { setEditing(false); setDraftImages([]); }}
                style={{ marginLeft: 'auto' }}
              >
                Cancel
              </button>
              <button
                className="primary-btn"
                onClick={() => { onSave(draftImages); setEditing(false); }}
              >
                Save
              </button>
            </div>
          )}
        </>
      )}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            backgroundColor: 'rgba(0,0,0,0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            cursor: 'zoom-out',
          }}
        >
          <img
            src={lightbox}
            alt={p.name}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '95%', maxHeight: '92%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
          />
        </div>
      )}
    </Card>
  );
}
