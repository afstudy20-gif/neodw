import { useRef, useState } from 'react';

interface Props {
  onFilesLoaded: (files: File[]) => void;
  isLoading: boolean;
}

export function DicomDropzone({ onFilesLoaded, isLoading }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function openFolderPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.files) {
        return;
      }
      const files = filterDicomFiles(Array.from(target.files));
      if (files.length > 0) {
        onFilesLoaded(files);
      }
    };
    input.click();
  }

  return (
    <div
      className={`dropzone ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const files = filterDicomFiles(Array.from(event.dataTransfer.files));
        if (files.length > 0) {
          onFilesLoaded(files);
        }
      }}
    >
      <div className="dropzone-card">
        <p className="dropzone-kicker">Coronary CT Research Workspace</p>
        <h1>CCTA QCA + CT-FFR Workbench</h1>
        <p className="dropzone-copy">
          Load DICOM data, build coronary centerlines in the 3-view MPR workspace, and capture
          manual QCA metrics. This first release is a research scaffold.
        </p>
        <div className="dropzone-actions">
          <button className="primary-btn" onClick={() => inputRef.current?.click()} disabled={isLoading}>
            Open Files
          </button>
          <button className="secondary-btn" onClick={openFolderPicker} disabled={isLoading}>
            Open Folder
          </button>
        </div>
        <p className="dropzone-hint">DICOM processing stays local in the browser.</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".dcm,.dicom,.DCM,.DICOM,application/dicom"
        style={{ display: 'none' }}
        onChange={(event) => {
          const fileList = event.target.files;
          if (!fileList) {
            return;
          }
          const files = filterDicomFiles(Array.from(fileList));
          if (files.length > 0) {
            onFilesLoaded(files);
          }
        }}
      />
    </div>
  );
}

function filterDicomFiles(files: File[]): File[] {
  return files.filter((file) => {
    const name = file.name.toLowerCase();
    return (
      name.endsWith('.dcm') ||
      name.endsWith('.dicom') ||
      !name.includes('.') ||
      file.type === 'application/dicom'
    );
  });
}
