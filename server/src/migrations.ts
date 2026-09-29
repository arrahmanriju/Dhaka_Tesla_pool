import fs from 'fs';
import { sequelize, storagePath } from './models';

/**
 * One-off, idempotent upgrade of an existing SQLite `Users` table:
 *   - adds the `phone` column, and
 *   - makes `email` nullable (it used to be NOT NULL).
 *
 * `sequelize.sync()` never alters existing tables, and SQLite cannot drop a NOT NULL
 * constraint in place, so the table is rebuilt (SQLite's documented 12-step procedure).
 * Foreign keys are switched OFF during the rebuild: Vehicles and RideRequests reference
 * Users with ON DELETE CASCADE, so dropping Users with them ON would delete their rows.
 * A copy of the database file is saved next to it first.
 */
export async function migrateUsersTable(): Promise<void> {
  const [cols] = (await sequelize.query('PRAGMA table_info(`Users`)')) as [
    { name: string; notnull: number }[],
    unknown,
  ];
  if (cols.length === 0) return; // fresh database — sync() will create the table

  const email = cols.find((c) => c.name === 'email');
  const hasPhone = cols.some((c) => c.name === 'phone');
  if (hasPhone && email && email.notnull === 0) return; // already up to date

  if (storagePath !== ':memory:' && fs.existsSync(storagePath)) {
    const backup = `${storagePath}.pre-phone-migration.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(storagePath, backup);
    console.log(`[migrate] Users: backed up database to ${backup}`);
  }

  const keep = ['id', 'name', 'email', 'phone', 'role', 'password', 'isOnline', 'createdAt', 'updatedAt'].filter(
    (c) => cols.some((old) => old.name === c),
  );
  const columnList = keep.map((c) => `\`${c}\``).join(', ');

  // Must run on one connection, so plain BEGIN/COMMIT rather than a Sequelize transaction.
  await sequelize.query('PRAGMA foreign_keys = OFF');
  try {
    await sequelize.query('BEGIN');
    await sequelize.query('DROP TABLE IF EXISTS `Users_new`');
    await sequelize.query(
      'CREATE TABLE `Users_new` (' +
        '`id` UUID PRIMARY KEY, ' +
        '`name` VARCHAR(255) NOT NULL, ' +
        '`email` VARCHAR(255) UNIQUE, ' +
        '`phone` VARCHAR(255) UNIQUE, ' +
        '`role` TEXT NOT NULL, ' +
        '`password` VARCHAR(255) NOT NULL, ' +
        '`isOnline` TINYINT(1) NOT NULL DEFAULT 0, ' +
        '`createdAt` DATETIME NOT NULL, ' +
        '`updatedAt` DATETIME NOT NULL)',
    );
    await sequelize.query(`INSERT INTO \`Users_new\` (${columnList}) SELECT ${columnList} FROM \`Users\``);
    await sequelize.query('DROP TABLE `Users`');
    await sequelize.query('ALTER TABLE `Users_new` RENAME TO `Users`');
    const [violations] = (await sequelize.query('PRAGMA foreign_key_check')) as [unknown[], unknown];
    if (violations.length > 0) throw new Error('foreign_key_check failed after Users rebuild');
    await sequelize.query('COMMIT');
    console.log('[migrate] Users: added phone column, email is now optional');
  } catch (err) {
    await sequelize.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await sequelize.query('PRAGMA foreign_keys = ON');
  }
}
