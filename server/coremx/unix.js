'use strict';
const fs = require('node:fs/promises');
const net = require('node:net');
async function removeStaleSocket(filename) {
    try {
        const stat = await fs.lstat(filename);
        if (!stat.isSocket()) throw new Error('Refusing to replace non-socket path');
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    const active = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: filename });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', (e) => {
            if (['ECONNREFUSED', 'ENOENT'].includes(e.code)) resolve(false);
            else reject(e);
        });
    });
    if (active) throw new Error('Unix socket already in use');
    await fs.unlink(filename).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
    });
}
module.exports = { removeStaleSocket };
