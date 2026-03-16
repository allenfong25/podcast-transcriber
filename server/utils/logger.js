const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'app.log');

function ensureLogDir() {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

function serializeError(error) {
    if (!error) return null;

    return {
        message: error.message,
        stack: error.stack,
        code: error.code,
        status: error.status
    };
}

function writeLog(level, message, meta = {}) {
    ensureLogDir();

    const payload = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta
    };

    fs.appendFileSync(logFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

function info(message, meta = {}) {
    writeLog('info', message, meta);
}

function error(message, err, meta = {}) {
    writeLog('error', message, {
        ...meta,
        error: serializeError(err)
    });
}

module.exports = {
    info,
    error,
    logFile
};
