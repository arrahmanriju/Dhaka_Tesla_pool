import fs from 'fs';
import { sequelize, storagePath } from './models';
import { recalculatePoolFares } from './utils/poolFares';

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

/**
 * Idempotent: adds `RideRequests.allowSharing` to a database created before private rides existed.
 * Existing rows become shared rides (DEFAULT 1), which is how they were treated before.
 * `sequelize.sync()` never adds columns to an existing table, so this has to be done by hand.
 */
export async function migrateRideRequestsTable(): Promise<void> {
  const [cols] = (await sequelize.query('PRAGMA table_info(`RideRequests`)')) as [{ name: string }[], unknown];
  if (cols.length === 0) return; // fresh database — sync() will create the table with the column
  if (cols.some((c) => c.name === 'allowSharing')) return;

  await sequelize.query('ALTER TABLE `RideRequests` ADD COLUMN `allowSharing` TINYINT(1) NOT NULL DEFAULT 1');
  console.log('[migrate] RideRequests: added allowSharing column');
}

/**
 * Database-level guarantee behind "one active ride per passenger": a partial unique index over the
 * non-terminal statuses. The route checks first for a friendly error; this catches two requests
 * from the same passenger racing past that check.
 *
 * If a database already holds passengers with several active rides the index cannot be built. That
 * is logged instead of crashing startup (the route-level check still applies); cancel the extra
 * rides and restart to get the index.
 */
export async function ensureOneActiveRideIndex(): Promise<void> {
  try {
    await sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS `ride_requests_one_active_per_passenger` ON `RideRequests` (`passengerId`) ' +
        "WHERE `status` IN ('REQUESTED', 'MATCHED', 'DRIVER_ARRIVED', 'STARTED')",
    );
  } catch (err) {
    console.warn(
      '[migrate] RideRequests: could not create the one-active-ride index (some passenger has several active rides):',
      (err as Error).message,
    );
  }
}

/** `PRAGMA user_version` value meaning "RideRequests fares are stored as whole taka". */
export const FARES_IN_TAKA_VERSION = 1;

/** Records that fares are in whole taka, so migrateFaresToTaka() never converts them again. */
export async function markFaresInTaka(): Promise<void> {
  await sequelize.query(`PRAGMA user_version = ${FARES_IN_TAKA_VERSION}`);
}

/**
 * One-off, idempotent: fares used to be stored as integer paisa (৳140 = 14000). They are now whole
 * taka rounded to the nearest ৳5, so existing rows are divided by 100 and rounded.
 * Rides that are still open (pooled, not started) are then re-priced with the current fare model;
 * rides that have already STARTED have no boarding checkpoint, so they keep their converted fare.
 *
 * The database's `user_version` records that the conversion happened. A brand-new database (no
 * RideRequests table yet) is stamped immediately, because everything written to it is already
 * taka; the seed script does the same. A copy of the database file is saved first.
 */
export async function migrateFaresToTaka(): Promise<void> {
  const [cols] = (await sequelize.query('PRAGMA table_info(`RideRequests`)')) as [{ name: string }[], unknown];
  if (cols.length === 0) {
    await markFaresInTaka(); // fresh database — sync() will create the table with taka semantics
    return;
  }

  const [versionRows] = (await sequelize.query('PRAGMA user_version')) as [{ user_version: number }[], unknown];
  if ((versionRows[0]?.user_version ?? 0) >= FARES_IN_TAKA_VERSION) return; // already converted

  if (storagePath !== ':memory:' && fs.existsSync(storagePath)) {
    const backup = `${storagePath}.pre-taka-migration.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(storagePath, backup);
    console.log(`[migrate] RideRequests: backed up database to ${backup}`);
  }

  // Conversion and the version stamp commit together, on one connection (plain BEGIN/COMMIT).
  const toTaka = (column: string) => `\`${column}\` = CAST(ROUND(\`${column}\` / 500.0) AS INTEGER) * 5`; // paisa/100, nearest 5
  await sequelize.query('BEGIN');
  try {
    await sequelize.query(
      `UPDATE \`RideRequests\` SET ${toTaka('baseFare')}, ${toTaka('estimatedFare')}, ${toTaka('poolDiscount')}`,
    );
    await markFaresInTaka();
    await sequelize.query('COMMIT');
  } catch (err) {
    await sequelize.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  const [pools] = (await sequelize.query(
    "SELECT DISTINCT `vehicleId` FROM `RideRequests` WHERE `vehicleId` IS NOT NULL AND `status` NOT IN ('CANCELLED', 'CANCELLED_IN_TRANSIT', 'COMPLETED')",
  )) as [{ vehicleId: string }[], unknown];
  for (const { vehicleId } of pools) await recalculatePoolFares(vehicleId);
  console.log(`[migrate] RideRequests: fares converted to whole taka (${pools.length} open pool(s) re-priced)`);
}

/**
 * Idempotent: adds the columns behind mid-trip cancellation to a database created before it existed:
 * `RideRequests.cancellationZone` and `RideEvents.cancellationZone / chargedFare / fullTripEstimate`.
 * `sequelize.sync()` never adds columns to an existing table. (The status column is plain TEXT in
 * SQLite, so the new CANCELLED_IN_TRANSIT value needs no change.)
 */
export async function migrateMidTripCancellation(): Promise<void> {
  const add = async (table: string, column: string, type: string) => {
    const [cols] = (await sequelize.query(`PRAGMA table_info(\`${table}\`)`)) as [{ name: string }[], unknown];
    if (cols.length === 0 || cols.some((c) => c.name === column)) return; // fresh database, or already done
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
    console.log(`[migrate] ${table}: added ${column} column`);
  };
  const renameColumn = async (table: string, from: string, to: string) => {
    const [cols] = (await sequelize.query(`PRAGMA table_info(\`${table}\`)`)) as [{ name: string }[], unknown];
    if (!cols.some((c) => c.name === from)) return;
    if (cols.some((c) => c.name === to)) await sequelize.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${from}\``);
    else await sequelize.query(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``);
  };
  await add('RideRequests', 'cancellationZone', 'TEXT');
  await add('RideEvents', 'cancellationZone', 'VARCHAR(255)');
  await add('RideEvents', 'chargedFare', 'INTEGER');
  await renameColumn('RideEvents', 'lockedFare', 'fullTripEstimate'); // an early version of this feature named it lockedFare
  await add('RideEvents', 'fullTripEstimate', 'INTEGER');
}

/**
 * Idempotent: adds the columns behind simulated payments to a database created before they existed:
 * `Users.walletBalance` and `RideRequests.paymentMethod / paymentStatus / paymentAmount`.
 * Existing users start with an empty wallet and existing rides are cash rides with nothing due
 * (their journeys were settled before payments existed). The `WalletTransactions` table is created
 * by `sequelize.sync()`.
 */
export async function migratePayments(): Promise<void> {
  const add = async (table: string, column: string, type: string) => {
    const [cols] = (await sequelize.query(`PRAGMA table_info(\`${table}\`)`)) as [{ name: string }[], unknown];
    if (cols.length === 0 || cols.some((c) => c.name === column)) return; // fresh database, or already done
    await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
    console.log(`[migrate] ${table}: added ${column} column`);
  };
  await add('Users', 'walletBalance', 'INTEGER NOT NULL DEFAULT 0');
  await add('RideRequests', 'paymentMethod', "TEXT NOT NULL DEFAULT 'cash'");
  await add('RideRequests', 'paymentStatus', "TEXT NOT NULL DEFAULT 'NOT_DUE'");
  await add('RideRequests', 'paymentAmount', 'INTEGER');
}
