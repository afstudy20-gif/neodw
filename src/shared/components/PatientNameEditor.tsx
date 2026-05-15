import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { patchAndDownloadZip, readFirstPatientName } from '../dicom/patientNameEditor';

interface Props {
  /** Ref to the live list of loaded source files. Modality updates this
   *  after `expandAndFilterDicom` resolves. */
  filesRef: MutableRefObject<File[]>;
  /** Used as the prefix in the downloaded zip's filename. */
  modalityLabel: string;
  /** Label shown on the trigger button — defaults to Turkish. */
  buttonLabel?: string;
}

export function PatientNameEditor({ filesRef, modalityLabel, buttonLabel = 'Hasta adı düzenle' }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const seededRef = useRef(false);

  // When the dialog opens, seed the input with the current PatientName
  // of the first loaded file. Only do this once per open so the user's
  // in-progress edit isn't overwritten.
  useEffect(() => {
    if (!open || seededRef.current) return;
    seededRef.current = true;
    const files = filesRef.current;
    if (!files || files.length === 0) return;
    void readFirstPatientName(files).then((existing) => {
      if (existing) setName(existing);
    });
  }, [open, filesRef]);

  function close() {
    if (busy) return;
    setOpen(false);
    setProgress('');
    seededRef.current = false;
  }

  async function onSave() {
    const files = filesRef.current;
    if (!files || files.length === 0) {
      setProgress('✗ Yüklü dosya yok');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setProgress('✗ Hasta adı boş olamaz');
      return;
    }
    setBusy(true);
    setProgress(`0/${files.length}`);
    try {
      const result = await patchAndDownloadZip(
        files,
        trimmed,
        `${modalityLabel}-${Date.now()}-renamed.zip`,
        (i, n) => setProgress(`${i}/${n}`)
      );
      const failedNote = result.failed > 0 ? `, ${result.failed} atlandı` : '';
      setProgress(`✓ ${result.patched} dosya güncellendi${failedNote}`);
      setTimeout(() => { setOpen(false); seededRef.current = false; setProgress(''); }, 1800);
    } catch (err) {
      console.error('[patient-name] patch failed', err);
      setProgress(`✗ ${err instanceof Error ? err.message : 'Bilinmeyen hata'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="patient-name-edit-btn"
        type="button"
        onClick={() => setOpen(true)}
        title="DICOM dosyalarındaki hasta adını düzenle ve ZIP olarak indir"
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hasta adı düzenle"
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--nd-surface, #1a1d23)',
              color: 'var(--nd-text, #e6edf3)',
              padding: 24,
              borderRadius: 8,
              minWidth: 380,
              maxWidth: 480,
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Hasta adı düzenle</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, opacity: 0.7, lineHeight: 1.5 }}>
              Yüklü tüm DICOM dosyalarındaki PatientName (0010,0010) etiketi yeni adla yeniden
              yazılır ve ZIP olarak indirilir. Görüntülenen sahne değişmez — değiştirilmiş dosyaları
              tekrar yüklemek isterseniz indirilen ZIP'i sürükleyip bırakın.
            </p>
            <label
              htmlFor="patient-name-input"
              style={{ display: 'block', fontSize: 12, opacity: 0.8, marginBottom: 4 }}
            >
              Yeni hasta adı
            </label>
            <input
              id="patient-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ör. ANONYMOUS"
              disabled={busy}
              autoFocus
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 14,
                background: 'var(--nd-bg, #0d1117)',
                color: 'inherit',
                border: '1px solid var(--nd-border, #30363d)',
                borderRadius: 4,
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            {progress && (
              <p style={{ margin: '0 0 16px', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                {progress}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  color: 'inherit',
                  border: '1px solid var(--nd-border, #30363d)',
                  borderRadius: 4,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                İptal
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={busy || !name.trim()}
                style={{
                  padding: '8px 16px',
                  background: busy || !name.trim() ? '#444' : 'var(--nd-accent, #2f81f7)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: busy || !name.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {busy ? 'Yamanıyor…' : 'Kaydet ve indir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
