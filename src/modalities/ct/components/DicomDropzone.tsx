import { useState, useCallback, useRef } from 'react';

interface Props {
  onFilesLoaded: (files: File[]) => void;
  isLoading: boolean;
}

export function DicomDropzone({ onFilesLoaded, isLoading }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const files: File[] = [];
      const items = e.dataTransfer.items;

      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) {
          const entryFiles = await readEntry(entry);
          files.push(...entryFiles);
        } else {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        onFilesLoaded(filterDicomFiles(files));
      }
    },
    [onFilesLoaded]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList) return;
      const files = filterDicomFiles(Array.from(fileList));
      if (files.length > 0) {
        onFilesLoaded(files);
      }
    },
    [onFilesLoaded]
  );

  const openFolderPicker = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.onchange = (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files) {
        const files = filterDicomFiles(Array.from(target.files));
        if (files.length > 0) onFilesLoaded(files);
      }
    };
    input.click();
  }, [onFilesLoaded]);

  return (
    <div
      className={`dropzone ${isDragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="dropzone-content">
        <div className="dropzone-icon">
          {isDragging ? '📥' : '🩻'}
        </div>
        <h2>{isDragging ? 'Drop files here' : 'DICOM Viewer'}</h2>
        <p className="dropzone-subtitle">
          Drag and drop DICOM files or a folder to begin
        </p>
        <p className="dropzone-or">or</p>
        <div className="dropzone-buttons">
          <button
            className="browse-btn"
            onClick={() => inputRef.current?.click()}
            disabled={isLoading}
          >
            Open Files
          </button>
          <button
            className="browse-btn folder-btn"
            onClick={openFolderPicker}
            disabled={isLoading}
          >
            Open Folder
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="*/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <p className="dropzone-hint">
          Supports .dcm files and DICOMDIR folders with nested subfolders. Files without .dcm extension are also accepted.
          <br />
          All processing happens locally in your browser.
        </p>
      </div>
    </div>
  );
}

async function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file((file) => resolve([file]), reject);
    });
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const allEntries: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries((entries) => resolve(entries), reject);
      });
      allEntries.push(...batch);
    } while (batch.length > 0);

    const files: File[] = [];
    for (const e of allEntries) {
      const subFiles = await readEntry(e);
      files.push(...subFiles);
    }
    return files;
  }

  return [];
}

function filterDicomFiles(files: File[]): File[] {
  return files.filter((file) => {
    // Skip obvious non-DICOM files
    const name = file.name.toLowerCase();
    const skipExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.txt', '.pdf', '.xml', '.html', '.json', '.csv', '.zip', '.tar', '.gz', '.exe', '.dll', '.js', '.css', '.md', '.yaml', '.yml', '.log', '.mp4', '.avi', '.mov'];
    if (skipExts.some(ext => name.endsWith(ext))) return false;
    // Accept everything else — DICOM files often have no extension or non-standard extensions
    // (.dcm, .dicom, .ima, .img, numeric names like "1.2.840...", etc.)
    // The actual DICOM validation happens in loadDicomFiles via dicomParser
    return true;
  });
}
