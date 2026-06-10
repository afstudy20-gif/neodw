type LogMethod = (...args: unknown[]) => void;

type Logger = Record<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'log', LogMethod> & {
  levels: typeof levels;
  getLevel: () => number;
  setLevel: (level: keyof typeof levels | number) => void;
  getLogger: (...names: string[]) => Logger;
};

const levels = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  SILENT: 5,
};

const loggers = new Map<string, Logger>();

function normalizeLevel(level: keyof typeof levels | number) {
  return typeof level === 'number' ? level : levels[level] ?? levels.WARN;
}

function createLogger(name: string): Logger {
  let currentLevel = levels.WARN;

  const invoke = (level: number, method: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'log') => (...args: unknown[]) => {
    if (level < currentLevel || currentLevel === levels.SILENT) return;
    const target = method === 'debug' ? 'log' : method;
    const fn = console[target] ?? console.log;
    fn?.call(console, ...args);
  };

  const logger = {
    trace: invoke(levels.TRACE, 'trace'),
    debug: invoke(levels.DEBUG, 'debug'),
    info: invoke(levels.INFO, 'info'),
    warn: invoke(levels.WARN, 'warn'),
    error: invoke(levels.ERROR, 'error'),
    log: invoke(levels.DEBUG, 'log'),
    levels,
    getLevel: () => currentLevel,
    setLevel: (level: keyof typeof levels | number) => {
      currentLevel = normalizeLevel(level);
    },
    getLogger: (...names: string[]) => getLogger(name, ...names),
  };

  return logger;
}

function getLogger(...names: string[]) {
  const key = names.filter(Boolean).join(':') || 'default';
  let logger = loggers.get(key);
  if (!logger) {
    logger = createLogger(key);
    loggers.set(key, logger);
  }
  return logger;
}

const defaultLogger = getLogger('default');

export default {
  ...defaultLogger,
  getLogger,
  noConflict: () => ({
    ...defaultLogger,
    getLogger,
  }),
};
