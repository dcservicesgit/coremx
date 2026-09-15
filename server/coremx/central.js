'use strict';
const path = require('node:path');
// Production resolves the inherited underlay. Source tests use the same checkout.
function central(relative) {
    const sourceTree = require('node:fs').existsSync(path.join(__dirname, '../database/envelope_v2.js'));
    return require(
        path.join(
            sourceTree
                ? path.join(__dirname, '..')
                : path.join(process.env.CENTRAL_DIR || path.resolve(__dirname, '../../../central'), 'server'),
            relative
        )
    );
}
module.exports = central;
