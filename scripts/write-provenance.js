'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [binary, output, centralRevision, centralDirty, overlayRevision, overlayDirty] = process.argv.slice(2);
fs.writeFileSync(output, JSON.stringify({
    central: { revision: centralRevision, dirty: centralDirty === 'true' },
    coremx: { revision: overlayRevision, dirty: overlayDirty === 'true' },
    centralfw: { name: require('node:path').basename(binary), sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') }
}, null, 2) + '\n');
