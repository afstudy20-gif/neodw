// Build clinical report PDFs (lazy-loaded jsPDF) for TAVI / QCA / Coronary-Seg.
// Returns Uint8Array suitable for downloading as .pdf or wrapping in DICOM
// Encapsulated PDF SOP via encapsulatedPdf.ts.

export interface ReportRow {
  label: string;
  value: string;
  unit?: string;
}

export interface ReportImage {
  title: string;
  dataUrl: string;
  caption?: string;
}

export interface ReportSection {
  title: string;
  rows: ReportRow[];
  images?: ReportImage[];
}

export interface PdfReportInput {
  title: string;
  patientName?: string;
  patientId?: string;
  studyDescription?: string;
  modality?: string;
  generatedAt?: Date;
  sections: ReportSection[];
  footnote?: string;
}

export async function buildPdfReport(input: PdfReportInput): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const MARGIN = 48;
  let y = MARGIN;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(input.title, MARGIN, y);
  y += 22;

  // Patient block
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const generated = input.generatedAt ?? new Date();
  const headerLines = [
    `Patient: ${input.patientName ?? '—'}   ID: ${input.patientId ?? '—'}`,
    `Study: ${input.studyDescription ?? '—'}   Modality: ${input.modality ?? '—'}`,
    `Generated: ${generated.toISOString()}   By: NeoDW Viewer`,
  ];
  for (const line of headerLines) {
    doc.text(line, MARGIN, y);
    y += 14;
  }

  // Divider
  y += 6;
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, W - MARGIN, y);
  y += 16;

  // Sections
  for (const section of input.sections) {
    if (y > 760) {
      doc.addPage();
      y = MARGIN;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(section.title, MARGIN, y);
    y += 16;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    for (const row of section.rows) {
      if (y > 780) {
        doc.addPage();
        y = MARGIN;
      }
      const labelText = row.label;
      const valueText = row.unit ? `${row.value} ${row.unit}` : row.value;
      doc.text(labelText, MARGIN, y);
      doc.text(valueText, MARGIN + 220, y);
      y += 14;
    }

    if (section.images?.length) {
      y += 6;
      const gap = 12;
      const colW = (W - MARGIN * 2 - gap) / 2;
      const imgH = colW * 0.72;
      let col = 0;
      for (const image of section.images) {
        if (y + imgH + 28 > 780) {
          doc.addPage();
          y = MARGIN;
          col = 0;
        }
        const x = MARGIN + col * (colW + gap);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text(image.title, x, y);
        try {
          doc.addImage(image.dataUrl, 'PNG', x, y + 6, colW, imgH);
        } catch {
          doc.setFont('helvetica', 'normal');
          doc.text('Image unavailable', x, y + 24);
        }
        if (image.caption) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.text(image.caption, x, y + imgH + 18, { maxWidth: colW });
        }
        if (col === 0) {
          col = 1;
        } else {
          col = 0;
          y += imgH + 34;
        }
      }
      if (col === 1) y += imgH + 34;
    }
    y += 8;
  }

  if (input.footnote) {
    if (y > 760) {
      doc.addPage();
      y = MARGIN;
    }
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(input.footnote, MARGIN, 800, { maxWidth: W - MARGIN * 2 });
  }

  // Footer
  const pageCount = doc.internal.pages.length - 1;
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Page ${i} / ${pageCount}`, W - MARGIN, 820, { align: 'right' });
    doc.text('NeoDW — Research use only, not for clinical decision-making.', MARGIN, 820);
  }

  const buf = doc.output('arraybuffer');
  return new Uint8Array(buf);
}

export function downloadPdf(bytes: Uint8Array, filename = 'report.pdf'): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
