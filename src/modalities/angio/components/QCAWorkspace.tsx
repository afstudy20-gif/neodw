import type { Dispatch } from 'react';
import { StepNav } from './StepNav';
import { DiameterChart } from './DiameterChart';
import {
  CATHETER_DIAMETERS,
  type CalibrationData,
  type CatheterSize,
  type QCAAction,
  type QCASession,
} from '../qca/QCATypes';
import { calculateVFFR } from '../qca/ffrCalculation';
import { useState } from 'react';
import { FloatingPanel } from '../../../shared/components/FloatingPanel';

interface Props {
  session: QCASession;
  dispatch: Dispatch<QCAAction>;
  currentFrame: number;
  imageCount: number;
}

function fmt(val: number | undefined | null, digits = 2): string {
  return val == null ? '\u2014' : val.toFixed(digits);
}

export function QCAWorkspace({ session, dispatch, currentFrame, imageCount }: Props) {
  const [catheterSize, setCatheterSize] = useState<CatheterSize>('6F');
  const [aoPress, setAoPress] = useState(100);
  const [reportFloat, setReportFloat] = useState(true);

  const calibrationDone = session.calibration != null && session.calibration.mmPerPixel > 0;
  const analysisDone = session.measurements != null;

  function handleStartCalibration() {
    const diam = CATHETER_DIAMETERS[catheterSize];
    dispatch({
      type: 'SET_CALIBRATION',
      data: {
        method: 'catheter',
        mmPerPixel: 0,
        catheterSize,
        catheterDiameterMm: diam,
        catheterPixelWidth: 0,
        catheterLine: null,
      },
    });
    dispatch({ type: 'SET_INTERACTION', mode: 'calibration-line' });
  }

  function exportPNG() {
    const vpCanvas = document.getElementById('viewport-angio')?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!vpCanvas) return;
    try {
      const dataUrl = vpCanvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `qca-export-${Date.now()}.png`;
      a.click();
    } catch (err) {
      console.error('PNG export failed:', err);
    }
  }

  function exportCSV(s: QCASession) {
    if (!s.measurements) return;
    const m = s.measurements;
    const rows: string[][] = [
      ['Metric', 'Value', 'Unit'],
      ['Diameter Stenosis', fmt(m.diameterStenosis, 1), '%'],
      ['MLD', fmt(m.mld), 'mm'],
      ['Reference Diameter', fmt(m.referenceDiameter), 'mm'],
      ['Lesion Length', fmt(m.lesionLength), 'mm'],
      ['Area Stenosis', fmt(m.areaStenosis, 1), '%'],
      ['DMax', fmt(m.dMax), 'mm'],
      ['Proximal Ref Diameter', fmt(m.proximalRefDiameter), 'mm'],
      ['Distal Ref Diameter', fmt(m.distalRefDiameter), 'mm'],
      ['Segment Length', fmt(m.segmentLength), 'mm'],
    ];
    if (s.calibration) {
      rows.push(['Pixel Size', s.calibration.mmPerPixel.toFixed(4), 'mm/px']);
    }
    if (s.ffrResult) {
      rows.push(['vFFR', s.ffrResult.vffr.toFixed(2), '']);
      rows.push(['Aortic Pressure', String(s.ffrResult.aoPress), 'mmHg']);
      rows.push(['Significant', s.ffrResult.isSignificant ? 'Yes' : 'No', '']);
    }
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qca-report-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCalculateFFR() {
    if (!session.contour || !session.referenceDiameters.length) return;
    const result = calculateVFFR(session.contour, session.referenceDiameters, aoPress);
    dispatch({ type: 'SET_FFR', result });
  }

  return (
    <aside className="qca-panel">
      <StepNav
        currentStep={session.step}
        onStepChange={(step) => dispatch({ type: 'SET_STEP', step })}
        calibrationDone={calibrationDone}
        analysisDone={analysisDone}
      />

      <div className="qca-scroll">
        {/* ── Step 1: Images ── */}
        {session.step === 'images' && (
          <div className="qca-section">
            <h3>Frame Selection</h3>
            <p className="qca-hint">
              Select an end-diastolic frame with good contrast opacification.
              Use the cine controls to find the optimal frame.
            </p>
            <div className="qca-metric-row">
              <span>Current Frame</span>
              <strong>{currentFrame + 1} / {imageCount}</strong>
            </div>
            <button
              className="primary-btn small"
              onClick={() => {
                dispatch({ type: 'SET_FRAME', index: currentFrame });
                dispatch({ type: 'SET_STEP', step: 'calibration' });
              }}
            >
              Use This Frame
            </button>
          </div>
        )}

        {/* ── Step 2: Calibration ── */}
        {session.step === 'calibration' && (
          <div className="qca-section">
            <h3>Catheter Calibration</h3>
            <p className="qca-hint">
              Select the catheter size, then click on <strong>both edges</strong> of the
              catheter shaft to measure its pixel width. The known diameter will be
              used to compute the pixel-to-mm calibration factor.
            </p>

            <label className="qca-field">
              <span>Catheter Size</span>
              <select
                value={catheterSize}
                onChange={(e) => setCatheterSize(e.target.value as CatheterSize)}
              >
                <option value="5F">5F (1.67 mm)</option>
                <option value="6F">6F (2.0 mm)</option>
                <option value="7F">7F (2.33 mm)</option>
                <option value="8F">8F (2.67 mm)</option>
              </select>
            </label>

            <button
              className="primary-btn small"
              onClick={handleStartCalibration}
            >
              Draw Calibration Line
            </button>

            {session.calibration && session.calibration.mmPerPixel > 0 && (
              <div className="qca-result-card success">
                <div className="qca-metric-row">
                  <span>Pixel Size</span>
                  <strong>{session.calibration.mmPerPixel.toFixed(4)} mm/px</strong>
                </div>
                <div className="qca-metric-row">
                  <span>Catheter Width</span>
                  <strong>{session.calibration.catheterPixelWidth.toFixed(1)} px</strong>
                </div>
                <button
                  className="primary-btn small"
                  onClick={() => {
                    dispatch({ type: 'SET_STEP', step: 'analysis' });
                    dispatch({ type: 'SET_INTERACTION', mode: 'place-proximal' });
                  }}
                >
                  Proceed to Analysis
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Analysis ── */}
        {session.step === 'analysis' && (
          <div className="qca-section">
            <h3>Vessel Analysis</h3>

            {!session.proximalPoint && (
              <>
                <p className="qca-hint">
                  Click on the angiogram to place the <strong>Proximal (P)</strong> marker
                  at the start of the vessel segment.
                </p>
                <button
                  className="primary-btn small"
                  onClick={() => dispatch({ type: 'SET_INTERACTION', mode: 'place-proximal' })}
                >
                  Place Proximal Point
                </button>
              </>
            )}

            {session.proximalPoint && !session.distalPoint && (
              <>
                <p className="qca-hint">
                  Click along the vessel to add guide points.
                  <strong> Double-click</strong> to place the <strong>Distal (D)</strong> marker
                  and finish the segment.
                </p>
                <div className="qca-btn-row">
                  <button
                    className={`ghost-btn ${session.interactionMode === 'place-centerline' ? 'active' : ''}`}
                    onClick={() => dispatch({ type: 'SET_INTERACTION', mode: 'place-centerline' })}
                  >
                    Add Guide Points
                  </button>
                  <button
                    className="primary-btn small"
                    onClick={() => dispatch({ type: 'SET_INTERACTION', mode: 'place-distal' })}
                  >
                    Place Distal Point
                  </button>
                </div>
              </>
            )}

            {session.proximalPoint && session.distalPoint && !session.contour && (
              <p className="qca-hint">
                Processing contour detection...
              </p>
            )}

            {/* Measurement Results */}
            {session.measurements && (
              <>
                <div className="qca-result-card">
                  <div className="qca-metric-row highlight">
                    <span>% Diameter Stenosis</span>
                    <strong>{fmt(session.measurements.diameterStenosis, 1)}%</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>MLD</span>
                    <strong>{fmt(session.measurements.mld)} mm</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>Reference Diameter</span>
                    <strong>{fmt(session.measurements.referenceDiameter)} mm</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>Lesion Length</span>
                    <strong>{fmt(session.measurements.lesionLength)} mm</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>% Area Stenosis</span>
                    <strong>{fmt(session.measurements.areaStenosis, 1)}%</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>DMax</span>
                    <strong>{fmt(session.measurements.dMax)} mm</strong>
                  </div>
                  <div className="qca-metric-row">
                    <span>Segment Length</span>
                    <strong>{fmt(session.measurements.segmentLength)} mm</strong>
                  </div>
                </div>

                {/* Chart mode tabs */}
                <div className="qca-tabs">
                  <button
                    className={`qca-tab ${session.chartMode === 'diameter' ? 'active' : ''}`}
                    onClick={() => dispatch({ type: 'SET_CHART_MODE', mode: 'diameter' })}
                  >
                    Diameter
                  </button>
                  <button
                    className={`qca-tab ${session.chartMode === 'area' ? 'active' : ''}`}
                    onClick={() => dispatch({ type: 'SET_CHART_MODE', mode: 'area' })}
                  >
                    Area
                  </button>
                </div>

                {session.contour && (
                  <DiameterChart
                    contour={session.contour}
                    referenceDiameters={session.referenceDiameters}
                    measurements={session.measurements}
                    ffrResult={session.ffrResult}
                    chartMode={session.chartMode}
                    lesionStartIdx={session.lesionStartOverride}
                    lesionEndIdx={session.lesionEndOverride}
                    onLesionBoundsChange={(s, e) => dispatch({ type: 'SET_LESION_BOUNDS', startIdx: s, endIdx: e })}
                  />
                )}

                {/* vFFR Section */}
                <div className="qca-ffr-section">
                  <h3>Angio-Derived FFR (vFFR)</h3>
                  <p className="qca-hint">
                    Compute vessel FFR using the fixed-flow model (Poiseuille + Bernoulli).
                  </p>
                  <label className="qca-field">
                    <span>Aortic Pressure (mmHg)</span>
                    <input
                      type="number"
                      min="50"
                      max="200"
                      value={aoPress}
                      onChange={(e) => setAoPress(Math.max(50, Math.min(200, Number(e.target.value) || 100)))}
                    />
                  </label>
                  <button className="primary-btn small" onClick={handleCalculateFFR}>
                    Calculate vFFR
                  </button>

                  {session.ffrResult && (
                    <div className={`qca-ffr-result ${session.ffrResult.isSignificant ? 'significant' : 'normal'}`}>
                      <div className="qca-ffr-value">
                        <span>vFFR</span>
                        <strong>{session.ffrResult.vffr.toFixed(2)}</strong>
                      </div>
                      <div className="qca-ffr-interpretation">
                        {session.ffrResult.isSignificant
                          ? 'Functionally significant (\u2264 0.80) \u2014 consider revascularization'
                          : 'Not functionally significant (> 0.80) \u2014 medical therapy appropriate'}
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="qca-btn-row">
                  <button className="ghost-btn" onClick={() => {
                    dispatch({ type: 'CLEAR_ANALYSIS' });
                    dispatch({ type: 'SET_INTERACTION', mode: 'place-proximal' });
                  }}>
                    Re-place Points
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => dispatch({ type: 'CLEAR_ANALYSIS' })}
                  >
                    Clear &amp; Restart
                  </button>
                  <button
                    className="primary-btn small"
                    onClick={() => dispatch({ type: 'SET_STEP', step: 'report' })}
                  >
                    View Report
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step 4: Report (floating/inline) ── */}
        {session.step === 'report' && session.measurements && !reportFloat && (
          <div className="qca-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>QCA Report</h3>
              <button className="ghost-btn small" onClick={() => setReportFloat(true)} title="Rapor kutusunu floating/pop-out yap">⧉ Pop-out</button>
            </div>

            <div className="qca-report">
              <table className="qca-report-table">
                <tbody>
                  <tr><th colSpan={2}>Quantitative Coronary Analysis</th></tr>
                  <tr><td>Diameter Stenosis</td><td>{fmt(session.measurements.diameterStenosis, 1)}%</td></tr>
                  <tr><td>MLD</td><td>{fmt(session.measurements.mld)} mm</td></tr>
                  <tr><td>Reference Diameter</td><td>{fmt(session.measurements.referenceDiameter)} mm</td></tr>
                  <tr><td>Lesion Length</td><td>{fmt(session.measurements.lesionLength)} mm</td></tr>
                  <tr><td>Area Stenosis</td><td>{fmt(session.measurements.areaStenosis, 1)}%</td></tr>
                  <tr><td>DMax</td><td>{fmt(session.measurements.dMax)} mm</td></tr>
                  <tr><td>Proximal Ref D</td><td>{fmt(session.measurements.proximalRefDiameter)} mm</td></tr>
                  <tr><td>Distal Ref D</td><td>{fmt(session.measurements.distalRefDiameter)} mm</td></tr>
                  <tr><td>Segment Length</td><td>{fmt(session.measurements.segmentLength)} mm</td></tr>
                  {session.calibration && (
                    <tr><td>Pixel Size</td><td>{session.calibration.mmPerPixel.toFixed(4)} mm/px</td></tr>
                  )}
                  {session.ffrResult && (
                    <>
                      <tr><th colSpan={2}>Angio-Derived FFR</th></tr>
                      <tr><td>vFFR</td><td className={session.ffrResult.isSignificant ? 'danger' : 'success'}>{session.ffrResult.vffr.toFixed(2)}</td></tr>
                      <tr><td>Aortic Pressure</td><td>{session.ffrResult.aoPress} mmHg</td></tr>
                      <tr><td>Significance</td><td>{session.ffrResult.isSignificant ? 'Significant (\u2264 0.80)' : 'Not significant (> 0.80)'}</td></tr>
                    </>
                  )}
                </tbody>
              </table>

              {session.contour && (
                <DiameterChart
                  contour={session.contour}
                  referenceDiameters={session.referenceDiameters}
                  measurements={session.measurements}
                  ffrResult={session.ffrResult}
                  chartMode="diameter"
                />
              )}
            </div>

            <div className="qca-btn-row">
              <button
                className="ghost-btn"
                onClick={() => dispatch({ type: 'SET_STEP', step: 'analysis' })}
              >
                Back to Analysis
              </button>
              <button className="primary-btn small" onClick={() => window.print()}>
                Print Report
              </button>
              <button className="secondary-btn small" onClick={() => exportPNG()}>
                Export PNG
              </button>
              <button className="secondary-btn small" onClick={() => exportCSV(session)}>
                Export CSV
              </button>
            </div>
          </div>
        )}

        {session.step === 'report' && session.measurements && reportFloat && (
          <>
            <div className="qca-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>QCA Report (floating)</h3>
                <button className="ghost-btn small" onClick={() => setReportFloat(false)} title="Inline görünüme döndür">↲ Dock</button>
              </div>
              <p style={{ fontSize: 11, opacity: 0.7 }}>
                Rapor floating panelde açık. Sürükle / boyutlandır / kapat için panel başlığını kullan.
              </p>
            </div>
            <FloatingPanel
              title="QCA Report"
              onClose={() => setReportFloat(false)}
              initialWidth={480}
              initialHeight={560}
              minWidth={340}
              minHeight={320}
            >
              <div className="qca-section" style={{ padding: 12 }}>
                <div className="qca-report">
                  <table className="qca-report-table">
                    <tbody>
                      <tr><th colSpan={2}>Quantitative Coronary Analysis</th></tr>
                      <tr><td>Diameter Stenosis</td><td>{fmt(session.measurements.diameterStenosis, 1)}%</td></tr>
                      <tr><td>MLD</td><td>{fmt(session.measurements.mld)} mm</td></tr>
                      <tr><td>Reference Diameter</td><td>{fmt(session.measurements.referenceDiameter)} mm</td></tr>
                      <tr><td>Lesion Length</td><td>{fmt(session.measurements.lesionLength)} mm</td></tr>
                      <tr><td>Area Stenosis</td><td>{fmt(session.measurements.areaStenosis, 1)}%</td></tr>
                      <tr><td>DMax</td><td>{fmt(session.measurements.dMax)} mm</td></tr>
                      <tr><td>Proximal Ref D</td><td>{fmt(session.measurements.proximalRefDiameter)} mm</td></tr>
                      <tr><td>Distal Ref D</td><td>{fmt(session.measurements.distalRefDiameter)} mm</td></tr>
                      <tr><td>Segment Length</td><td>{fmt(session.measurements.segmentLength)} mm</td></tr>
                      {session.calibration && (
                        <tr><td>Pixel Size</td><td>{session.calibration.mmPerPixel.toFixed(4)} mm/px</td></tr>
                      )}
                      {session.ffrResult && (
                        <>
                          <tr><th colSpan={2}>Angio-Derived FFR</th></tr>
                          <tr><td>vFFR</td><td className={session.ffrResult.isSignificant ? 'danger' : 'success'}>{session.ffrResult.vffr.toFixed(2)}</td></tr>
                          <tr><td>Aortic Pressure</td><td>{session.ffrResult.aoPress} mmHg</td></tr>
                          <tr><td>Significance</td><td>{session.ffrResult.isSignificant ? 'Significant (≤ 0.80)' : 'Not significant (> 0.80)'}</td></tr>
                        </>
                      )}
                    </tbody>
                  </table>
                  {session.contour && (
                    <DiameterChart
                      contour={session.contour}
                      referenceDiameters={session.referenceDiameters}
                      measurements={session.measurements}
                      ffrResult={session.ffrResult}
                      chartMode="diameter"
                    />
                  )}
                </div>
                <div className="qca-btn-row">
                  <button className="ghost-btn" onClick={() => dispatch({ type: 'SET_STEP', step: 'analysis' })}>Back to Analysis</button>
                  <button className="primary-btn small" onClick={() => window.print()}>Print</button>
                  <button className="secondary-btn small" onClick={() => exportPNG()}>PNG</button>
                  <button className="secondary-btn small" onClick={() => exportCSV(session)}>CSV</button>
                </div>
              </div>
            </FloatingPanel>
          </>
        )}
      </div>
    </aside>
  );
}
