import fs from 'fs';
import os from 'os';
import path from 'path';

// The suites call sequelize.sync({ force: true }) and wipe tables, so they must never share the
// development database (data/database.sqlite). Each Jest worker gets its own throwaway file (and
// therefore its own uploads folder, which lives next to the database file).
const dir = path.join(os.tmpdir(), 'tesla-pool-tests', `worker-${process.env.JEST_WORKER_ID ?? '0'}`);
fs.mkdirSync(dir, { recursive: true });
process.env.DB_STORAGE_PATH = path.join(dir, 'database.sqlite');
