'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const [binary, manifest] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(manifest));
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
if (c.httpWorkerVersion !== 1 || c.unixWorkers !== true || c.sha256 !== sha256) throw new Error('CentralFW capability manifest mismatch');
