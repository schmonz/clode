// A module that assigns exports and THEN throws during evaluation. The partial
// assignment is the point: it is what a broken cache hands back on a second
// require, looking like a module that loaded.
exports.partial = 'set before the throw';
throw new Error('boom during evaluation');
