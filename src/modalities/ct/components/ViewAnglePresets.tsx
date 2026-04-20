import React from 'react';

interface Props {
  onAngleChange: (laoRaoDeg: number, cranCaudDeg: number) => void;
}

const PRESETS = [
  { label: 'RAO30', lao: -30, cc: 0 },
  { label: 'RAO15', lao: -15, cc: 0 },
  { label: 'AP', lao: 0, cc: 0 },
  { label: 'LAO15', lao: 15, cc: 0 },
  { label: 'LAO30', lao: 30, cc: 0 },
  { label: 'LAO45', lao: 45, cc: 0 },
  { label: 'CRA15', lao: 0, cc: 15 },
  { label: 'CAU15', lao: 0, cc: -15 },
];

export const ViewAnglePresets: React.FC<Props> = ({ onAngleChange }) => {
  return (
    <div className="view-angle-presets">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          className="toolbar-btn toolbar-btn-sm"
          onClick={() => onAngleChange(p.lao, p.cc)}
          title={`${p.label} view`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
};
