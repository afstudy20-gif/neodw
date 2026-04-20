import { QCA_STEPS, QCA_STEP_LABELS, type QCAStep } from '../qca/QCATypes';

interface Props {
  currentStep: QCAStep;
  onStepChange: (step: QCAStep) => void;
  calibrationDone: boolean;
  analysisDone: boolean;
}

export function StepNav({ currentStep, onStepChange, calibrationDone, analysisDone }: Props) {
  function isEnabled(step: QCAStep): boolean {
    switch (step) {
      case 'images': return true;
      case 'calibration': return true;
      case 'analysis': return calibrationDone;
      case 'report': return analysisDone;
    }
  }

  return (
    <nav className="step-nav">
      {QCA_STEPS.map((step, idx) => {
        const enabled = isEnabled(step);
        const active = step === currentStep;
        const completed = QCA_STEPS.indexOf(currentStep) > idx;
        return (
          <button
            key={step}
            className={`step-nav-item ${active ? 'active' : ''} ${completed ? 'completed' : ''}`}
            disabled={!enabled}
            onClick={() => enabled && onStepChange(step)}
          >
            <span className="step-nav-number">{idx + 1}</span>
            <span className="step-nav-label">{QCA_STEP_LABELS[step]}</span>
            {idx < QCA_STEPS.length - 1 && <span className="step-nav-arrow">&rsaquo;</span>}
          </button>
        );
      })}
    </nav>
  );
}
