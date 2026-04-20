const LEVELS = {off: 0, error: 1, warn: 2, info: 3, debug: 4};
const PREFIX = '[SNCF]';

let _level = LEVELS.error;

export function setLevel(levelStr) {
    _level = LEVELS[levelStr] ?? LEVELS.error;
}

export function debug(...args) {
    if (_level >= LEVELS.debug)
        console.log(PREFIX, '[DEBUG]', ...args);
}

export function info(...args) {
    if (_level >= LEVELS.info)
        console.log(PREFIX, '[INFO]', ...args);
}

export function warn(...args) {
    if (_level >= LEVELS.warn)
        console.warn(PREFIX, '[WARN]', ...args);
}

export function error(...args) {
    if (_level >= LEVELS.error)
        console.error(PREFIX, '[ERROR]', ...args);
}
